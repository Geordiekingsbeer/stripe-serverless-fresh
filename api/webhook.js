import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

async function sendBookingNotification(booking, type) {
    const staffEmail = 'geordie.kingsbeer@gmail.com';
    const subject = `[NEW BOOKING - ${type}] Table ${booking.table_id} on ${booking.date}`;
    const body = `
        A new ${type} booking has been confirmed!
        Restaurant: ${booking.tenant_id}
        Table ID: ${booking.table_id}
        Date: ${booking.date}
        Time: ${booking.start_time} - ${booking.end_time}
        Notes: ${booking.host_notes || 'Stripe Payment Confirmed'}
        Customer Email: ${booking.customer_email || 'N/A'}
        
        -- SENT VIA VERCEL SERVERLESS FUNCTION --
    `;
    
    console.log(`Email Mock: Sending to ${staffEmail}. Subject: ${subject}`);
    return { success: true };
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

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const metadata = session.metadata;

        if (!metadata || !metadata.table_ids) {
            console.error('[BOOKING FAILURE] Missing metadata for booking in session:', session.id);
            return res.status(400).end();
        }

        const tableIds = metadata.table_ids.split(',');
        
        const [hour, minute] = metadata.booking_time.split(':').map(Number);
        const endTime = new Date();
        endTime.setHours(hour + 2);
        endTime.setMinutes(minute);
        const endTimeStr = `${String(endTime.getHours()).padStart(2, '0')}:${String(endTime.getMinutes()).padStart(2, '0')}:00`;

        const customerEmail = metadata.email || (session.customer_details ? session.customer_details.email : null);
        const receiveOffers = metadata.receive_offers;

        // Prepare composite booking object for notification
        const primaryBooking = {
            table_id: tableIds.join(', '),
            date: metadata.booking_date,
            start_time: metadata.booking_time,
            end_time: endTimeStr,
            tenant_id: metadata.tenant_id,
            host_notes: `Stripe Order: ${session.id}`,
            customer_email: customerEmail,
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
                    host_notes: `Stripe Order: ${session.id}`,
                    stripe_order_id: session.id, 
                    booking_ref: metadata.booking_ref, 
                    customer_email: customerEmail,
                    payment_status: 'PAID',
                    is_manual_booking: false,
                    receive_offers: (receiveOffers === 'TRUE'),
                });
            
            if (error) {
                console.error(`[SUPABASE FAILURE] Insert error for table ${tableId}:`, error.message);
            } else {
                console.log(`[BOOKING SUCCESS] Table ${tableId} booked for ${metadata.booking_date}`);
            }
        }
        
        // --- NEW: Send Email Notification for Customer Booking ---
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
            }
        }
    }

    return res.status(200).json({ received: true });
};
