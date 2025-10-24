import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const stripe = new Stripe(stripeSecretKey);
const supabase = createClient(supabaseUrl, supabaseServiceKey);


// --- UTILITY FUNCTIONS ---

async function getTenantDisplayName(tenantId) {
    const { data, error } = await supabase
        .from('tenants')
        .select('display_name')
        .eq('tenant_id', tenantId)
        .maybeSingle();

    if (error || !data) {
        console.error('Error fetching tenant display name:', error);
        return tenantId;
    }
    return data.display_name;
}

async function sendCustomerConfirmation(booking, displayName) {
    const senderEmail = 'info@dineselect.co';
    const customerEmail = booking.customer_email;
    const subject = `Your Premium Table Reservation Confirmed at ${displayName}`;
    const body = `
        <p>Dear ${booking.customer_name || 'Customer'},</p>
        <p>Your premium table reservation at <b>${displayName}</b> has been successfully confirmed and paid for.</p>
        <p><strong>Reservation Details: (REFUND NEEDED)</strong></p>
        <ul>
            <li><strong>Restaurant:</strong> ${displayName}</li>
            <li><strong>Date:</strong> ${booking.date}</li>
            <li><strong>Time:</strong> ${booking.start_time.substring(0, 5)} - ${booking.end_time.substring(0, 5)}</li>
            <li><strong>Table Number(s):</strong> ${booking.table_id}</li>
            <li><strong>Party Size:</strong> ${booking.party_size || 'N/A'}</li>
            <li><strong>Amount Paid:</strong> £${(booking.total_pence / 100).toFixed(2)}</li>
        </ul>
        <p>Your payment receipt has been sent separately by Stripe. Please contact us at <b>${senderEmail}</b> if you have any questions.</p>
        <p>Thank you!</p>
    `;
    
    try {
        await resend.emails.send({
            from: senderEmail, to: customerEmail, subject: subject, html: body,
        });
        console.log(`Email Sent: Successfully notified customer at ${customerEmail}.`);
        return { success: true };
    } catch (error) {
        console.error('Email Error: Failed to send customer confirmation via Resend:', error);
        return { success: false, error: error.message };
    }
}

async function sendBookingNotification(booking, type, displayName) {
    const staffEmail = 'geordie.kingsbeer@gmail.com';
    const senderEmail = 'info@dineselect.co';
    
    // NOTE: This notification subject is updated to warn of a failure!
    const subject = `[${type}] ${displayName}: Table(s) ${booking.table_id}`; 
    const body = `
        <p>A booking has been processed for <b>${displayName}</b>.</p>
        <p><strong>Customer:</strong> ${booking.customer_name || 'N/A'}</p>
        <ul>
            <li><strong>Party Size:</strong> ${booking.party_size || 'N/A'}</li>
            <li><strong>Table Number(s):</strong> ${booking.table_id}</li>
            <li><strong>Date:</strong> ${booking.date}</li>
            <li><strong>Time:</strong> ${booking.start_time} - ${booking.end_time}</li>
            <li><strong>Status:</strong> ${type}</li>
            <li><strong>Stripe Order ID:</strong> ${booking.host_notes.replace('Stripe Order: ', '')}</li>
            <li><strong>Customer Email:</strong> ${booking.customer_email || 'N/A'}</li>
        </ul>
        ${type === 'BOOKING CONFLICT FAIL' ? '<h3 style="color:red;">ACTION REQUIRED: MANUAL REFUND VIA STRIPE IS NEEDED.</h3><p>The table was double-booked in the database, but the customer paid. The payment must be refunded immediately.</p>' : ''}
    `;
    
    try {
        await resend.emails.send({
            from: senderEmail, to: staffEmail, subject: subject, html: body,
        });
        console.log(`Email Sent: Successfully notified staff.`);
        return { success: true };
    } catch (error) {
        console.error('Email Error: Failed to send staff notification via Resend:', error);
        return { success: false, error: error.message };
    }
}


// --- MAIN WEBHOOK HANDLER ---

const getRawBody = (req) => {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
};

export default async (req, res) => {
    console.log('--- WEBHOOK HANDLER ENTRY POINT ---'); 

    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    let event;
    try {
        const buf = await getRawBody(req);
        const signature = req.headers['stripe-signature'];
        
        event = stripe.webhooks.constructEvent(
            buf.toString(), 
            signature, 
            webhookSecret
        );
    } catch (err) {
        console.error(`[WEBHOOK FAILURE] Signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`); 
    }
    
    const eventId = event.id;
    const metadata = event.data.object.metadata || {};

    // 1. IDEMPOTENCY CHECK
    const { data: existingEvent, error: selectError } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('stripe_event_id', eventId)
        .maybeSingle();

    if (selectError) {
        console.error('[IDEMPOTENCY FAILURE] Supabase Select Error:', selectError.message);
        return res.status(500).send(`Database Error: Could not check event ${eventId}`);
    } else if (existingEvent) {
        console.log(`[IDEMPOTENCY] Event ${eventId} already processed.`);
        return res.status(200).json({ received: true });
    }
    
    // --- START PROCESSING EVENT ---

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        // 2. LOG THE EVENT IMMEDIATELY
        const { error: insertEventError } = await supabase
            .from('webhook_events')
            .insert({
                stripe_event_id: eventId,
                event_type: event.type,
                tenant_id: metadata.tenant_id, 
                status: 'processing',
                host_notes: `Ref: ${metadata.booking_ref}`,
            });

        if (insertEventError) {
            console.error('[WEBHOOK_EVENTS FAILURE] CRITICAL: Failed to log new event:', insertEventError.message);
            return res.status(500).send(`Database Error: Could not log event ${eventId}`); 
        } else {
            console.log('[WEBHOOK_EVENTS SUCCESS] Event logged as processing.');
        }

        const totalAmountPence = session.amount_total;
        const tableIds = metadata.table_ids.split(','); 
        
        // Timezone safe calculation for 2 hours later
        const [hour, minute] = metadata.booking_time.split(':').map(Number);
        const bookingDateTime = new Date();
        bookingDateTime.setHours(hour);
        bookingDateTime.setMinutes(minute);
        bookingDateTime.setMinutes(bookingDateTime.getMinutes() + 120); 

        const endTimeStr = `${String(bookingDateTime.getHours()).padStart(2, '0')}:${String(bookingDateTime.getMinutes()).padStart(2, '0')}:00`;

        const customerEmail = metadata.email || (session.customer_details ? session.customer_details.email : null);
        const receiveOffers = metadata.receive_offers;
        
        // Fetch Display Name once
        const tenantDisplayName = await getTenantDisplayName(metadata.tenant_id);

        const primaryBooking = {
            table_id: tableIds.join(', '),
            date: metadata.booking_date,
            start_time: metadata.booking_time,
            end_time: endTimeStr,
            tenant_id: metadata.tenant_id,
            host_notes: `Stripe Order: ${session.id}`, 
            customer_email: customerEmail,
            customer_name: metadata.customer_name || 'Customer',
            party_size: metadata.party_size || 'N/A',
            total_pence: totalAmountPence, 
            booking_ref: metadata.booking_ref,
        };
        
        // CRITICAL FLAG: Check if any booking attempt fails due to the database trigger
        let allBookingsSuccessful = true;
        
        // 3. Insert into premium_slots (CRITICAL BOOKING DATA)
        for (const tableId of tableIds) {
            console.log(`[PREMIUM_SLOTS DEBUG] Attempting insert for table ${tableId}...`);
            const { error } = await supabase
                .from('premium_slots')
                .insert({
                    tenant_id: metadata.tenant_id,
                    table_id: Number(tableId),
                    date: metadata.booking_date,
                    start_time: metadata.booking_time,
                    end_time: endTimeStr, 
                    host_notes: primaryBooking.host_notes, 
                    stripe_order_id: session.id, 
                    booking_ref: metadata.booking_ref, 
                    customer_email: customerEmail,
                    payment_status: 'PAID',
                    is_manual_booking: false,
                    receive_offers: (receiveOffers === 'TRUE'),
                    total_pence: totalAmountPence,
                    customer_name: primaryBooking.customer_name, 
                });
            
            if (error) {
                console.error(`[PREMIUM_SLOTS FAILURE] Insert error for table ${tableId}:`, error.message);
                // CRITICAL CHANGE: Mark the entire transaction as failed
                allBookingsSuccessful = false; 
                // Do NOT return here, continue trying to process other tables (if multi-table booking)
            } else {
                console.log(`[PREMIUM_SLOTS SUCCESS] Table ${tableId} booked.`);
            }
        }
        
        // 4. Update Engagement Tracking (REMOVED)
        console.log('[TRACKING SKIPPED] Engagement tracking update skipped as requested.');
        
        // 5. Send Notifications (Staff and Customer) - CONDITIONAL EXECUTION
        if (allBookingsSuccessful) {
             await sendBookingNotification(primaryBooking, 'CUSTOMER PAID', tenantDisplayName);
             await sendCustomerConfirmation(primaryBooking, tenantDisplayName); 
             console.log('User notified of successful booking.');
             
             // 6. Insert into marketing_optins (Consent Data) - Only on success
             if (receiveOffers === 'TRUE' && customerEmail) {
                const optInRow = {
                    email: customerEmail,
                    tenant_id: metadata.tenant_id,
                    booking_date: metadata.booking_date,
                    location: metadata.tenant_id,
                    source: metadata.booking_ref || 'table_booking',
                    consent_text: 'Send me restaurant discounts and offers',
                    is_subscribed: true
                };
                
                const { error: optinError } = await supabase
                    .from('marketing_optins')
                    .upsert([optInRow], { onConflict: 'email, tenant_id' });

                if (optinError) {
                    console.error('Error inserting marketing opt-in:', optinError);
                }
            }

             // 7. Update webhook_events status to 'completed'
             const { error: updateError } = await supabase
                .from('webhook_events')
                .update({ status: 'completed' })
                .eq('stripe_event_id', eventId);
             
             if (updateError) {
                 console.error('Failed to mark webhook_event as completed:', updateError.message);
             }

        } else {
            console.warn(`[T2 FAILURE LOG] Booking for ref ${metadata.booking_ref} failed due to conflict. No confirmation email sent to customer.`);
            
            // Send urgent alert to staff indicating a refund is needed
            await sendBookingNotification(primaryBooking, 'BOOKING CONFLICT FAIL', tenantDisplayName);
            
            // NOTE: We do NOT send a success confirmation to the customer.
            
            // We still return 200 to Stripe, confirming we processed their webhook, 
            // even though the DB update failed (Stripe is not responsible for the conflict).
        }
    } // End of checkout.session.completed block

    // 8. Return success to Stripe (Final Step)
    return res.status(200).json({ received: true });
};
