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


// --- UTILITY FUNCTIONS (NO CHANGE) ---

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

function cleanNotes(notes) {
    if (!notes) return 'Stripe Payment Confirmed (No additional notes)';
    const stripeIdRegex = /(Order|Transaction)?\s*:\s*(cs_live_|cs_test_)[a-zA-Z0-9]{24,}/g;
    
    let cleanedNotes = notes.replace(stripeIdRegex, '').trim();
    cleanedNotes = cleanedNotes.replace(/^,?\s*|,\s*$/g, '').trim();

    return cleanedNotes || 'Stripe Payment Confirmed (No additional notes)';
}

// --- EMAIL FUNCTIONS (NO CHANGE) ---
async function sendCustomerConfirmation(booking, displayName) {
    const senderEmail = 'info@dineselect.co';
    const customerEmail = booking.customer_email;

    const subject = `Your Premium Table Reservation Confirmed at ${displayName}`;
    const body = `
        <p>Dear ${booking.customer_name || 'Customer'},</p>
        <p>Your premium table reservation at <b>${displayName}</b> has been successfully confirmed and paid for.</p>
        <p><strong>Reservation Details:</strong></p>
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
            from: senderEmail,
            to: customerEmail,
            subject: subject,
            html: body,
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
    
    const subject = `[NEW BOOKING - ${type}] ${displayName}: Table(s) ${booking.table_id}`;
    const body = `
        <p>A new <b>${type}</b> booking has been confirmed for <b>${displayName}</b>.</p>
        <p><strong>Customer:</strong> ${booking.customer_name || 'N/A'}</p>
        <ul>
            <li><strong>Party Size:</strong> ${booking.party_size || 'N/A'}</li>
            <li><strong>Table Number(s):</strong> ${booking.table_id}</li>
            <li><strong>Date:</strong> ${booking.date}</li>
            <li><strong>Time:</strong> ${booking.start_time} - ${booking.end_time}</li>
            <li><strong>Source:</strong> ${type}</li>
            <li><strong>Stripe Order ID:</strong> ${booking.host_notes.replace('Stripe Order: ', '')}</li>
            <li><strong>Customer Email:</strong> ${booking.customer_email || 'N/A'}</li>
        </ul>
    `;
    
    try {
        await resend.emails.send({
            from: senderEmail,
            to: staffEmail,
            subject: subject,
            html: body,
        });
        console.log(`Email Sent: Successfully notified staff.`);
        return { success: true };
    } catch (error) {
        console.error('Email Error: Failed to send staff notification via Resend:', error);
        return { success: false, error: error.message };
    }
}


// --- MAIN WEBHOOK HANDLER (FIXED LOGIC) ---

const getRawBody = (req) => {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
};

export default async (req, res) => {
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
    const { data: existingEvent } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('stripe_event_id', eventId)
        .maybeSingle();

    if (existingEvent) {
        console.log(`[IDEMPOTENCY] Event ${eventId} already processed.`);
        return res.status(200).json({ received: true });
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const metadata = session.metadata;

        if (!metadata || !metadata.table_ids) {
            console.error('[BOOKING FAILURE] Missing metadata for booking in session:', session.id);
            return res.status(400).end();
        }

        const totalAmountPence = session.amount_total;

        const tableIds = metadata.table_ids.split(',');
        
        const [hour, minute] = metadata.booking_time.split(':').map(Number);
        const endTime = new Date();
        endTime.setHours(hour + 2);
        endTime.setMinutes(minute);
        const endTimeStr = `${String(endTime.getHours()).padStart(2, '0')}:${String(endTime.getMinutes()).padStart(2, '0')}:00`;

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

        // 1. Insert into premium_slots (Transactional Booking Data)
        for (const tableId of tableIds) {
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
                    payment_status: 'PAID', // CRITICAL: This is the source of truth for your report
                    is_manual_booking: false,
                    receive_offers: (receiveOffers === 'TRUE'),
                    total_pence: totalAmountPence,
                    customer_name: primaryBooking.customer_name, 
                });
            
            if (error) {
                console.error(`[SUPABASE FAILURE] Insert error for table ${tableId}:`, error.message);
            } else {
                console.log(`[BOOKING SUCCESS] Table ${tableId} booked for ${metadata.booking_date}`);
            }
        }
        
        // 2. Update Engagement Tracking (CRITICAL FIX FOR REPORTING ACCURACY)
        const { error: trackingUpdateError } = await supabase
            .from('engagement_tracking')
            .update({ 
                checkout_complete: 'TRUE',
                payment_successful: 'TRUE', // Explicitly mark success
                event_type: 'payment_successful'
            })
            .eq('booking_ref', metadata.booking_ref);

        if (trackingUpdateError) {
            console.error('[TRACKING FAILURE] Failed to update engagement_tracking:', trackingUpdateError.message);
        } else {
            console.log(`[TRACKING SUCCESS] Ref ${metadata.booking_ref} marked as complete.`);
        }
        
        // 3. Send Notifications (Staff and Customer)
        await sendBookingNotification(primaryBooking, 'CUSTOMER PAID', tenantDisplayName);
        await sendCustomerConfirmation(primaryBooking, tenantDisplayName); 

        // 4. Insert into marketing_optins (Consent Data)
        if (receiveOffers === 'TRUE' && customerEmail) {
