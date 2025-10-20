import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

function cleanNotes(notes) {
    if (!notes) return 'N/A';
    const stripeIdRegex = /(Order|Transaction)?\s*:\s*(cs_live_|cs_test_)[a-zA-Z0-9]{24,}/g;
    
    let cleanedNotes = notes.replace(stripeIdRegex, '').trim();
    cleanedNotes = cleanedNotes.replace(/^,?\s*|,\s*$/g, '').trim();

    return cleanedNotes || 'Stripe Payment Confirmed (No additional notes)';
}


async function sendBookingNotification(booking, type) {
    const staffEmail = 'geordie.kingsbeer@gmail.com';
    const senderEmail = 'onboarding@resend.dev'; 
    const cleanedNotes = cleanNotes(booking.host_notes);

    const subject = `[NEW BOOKING - ${type}] Table(s) ${booking.table_id} on ${booking.date}`;
    const body = `
        <p>A new <b>${type}</b> booking has been confirmed for <b>${booking.tenant_id}</b>!</p>
        <p><strong>Customer:</strong> ${booking.customer_name || 'N/A'}</p>
        <ul>
            <li><strong>Table ID(s):</strong> ${booking.table_id}</li>
            <li><strong>Date:</strong> ${booking.date}</li>
            <li><strong>Time:</strong> ${booking.start_time} - ${booking.end_time}</li>
            <li><strong>Source:</strong> ${type}</li>
            <li><strong>Notes:</strong> ${cleanedNotes}</li>
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
        console.log(`Email Sent: Successfully notified ${staffEmail} via Resend.`);
        return { success: true };
    } catch (error) {
        console.error('Email Error: Failed to send notification via Resend:', error);
        return { success: false, error: error.message };
    }
}

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const stripe = new Stripe(stripeSecretKey);
const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
    
    // --- START IDEMPOTENCY CHECK (NEW) ---
    const eventId = event.id;
    const { data: existingEvent, error: fetchError } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('stripe_event_id', eventId)
        .maybeSingle();

    if (existingEvent) {
        // Event already processed. Return 200 OK immediately.
        console.log(`[IDEMPOTENCY] Event ${eventId} already processed.`);
        return res.status(200).json({ received: true });
    }
    // --- END IDEMPOTENCY CHECK ---


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

        const primaryBooking = {
            table_id: tableIds.join(', '),
            date: metadata.booking_date,
            start_time: metadata.booking_time,
            end_time: endTimeStr,
            tenant_id: metadata.tenant_id,
            host_notes: `Stripe Order: ${session.id}`, 
            customer_email: customerEmail,
            customer_name: metadata.customer_name || 'Customer'
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
                    payment_status: 'PAID',
                    is_manual_booking: false,
                    receive_offers: (receiveOffers === 'TRUE'),
                    total_pence: totalAmountPence,
                });
            
            if (error) {
                console.error(`[SUPABASE FAILURE] Insert error for table ${tableId}:`, error.message);
                // CRITICAL: Since the booking failed, we don't log the eventId yet, 
                // allowing Stripe to retry. If we logged it, Stripe would stop retrying.
                return res.status(500).json({ error: 'Database insert failed.' });
            } else {
                console.log(`[BOOKING SUCCESS] Table ${tableId} booked for ${metadata.booking_date}`);
            }
        }
        
        await sendBookingNotification(primaryBooking, 'CUSTOMER PAID');

        // 2. Insert into marketing_optins (Consent Data)
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
                // Non-critical failure, allow process to continue
            }
        }
        
        // --- LOG EVENT ID AFTER ALL PROCESSING IS COMPLETE (NEW) ---
        const { error: logError } = await supabase
            .from('webhook_events')
            .insert({ stripe_event_id: eventId, event_type: event.type });
            
        if (logError) {
            console.error('[IDEMPOTENCY ERROR] Failed to log Stripe event ID:', logError);
            // Non-critical, still return 200 to Stripe so they don't retry, but log it.
        }
    }

    // Always return 200 OK to Stripe to confirm receipt and stop retries
    return res.status(200).json({ received: true });
};
