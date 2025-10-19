import Stripe from 'stripe'; 
import { createClient } from '@supabase/supabase-js';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET; 
const supabaseUrl = process.env.SUPABASE_URL; 
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

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
        const customerEmail = session.customer_details ? session.customer_details.email : metadata.email;

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
                    // --- ADDED MISSING COLUMNS ---
                    stripe_order_id: session.id,
                    booking_ref: metadata.booking_ref,
                    customer_email: customerEmail,
                    // staff_email is intentionally omitted here as it's not provided by the customer
                });
            
            if (error) {
                console.error(`[SUPABASE FAILURE] Insert error for table ${tableId}:`, error.message);
            } else {
                console.log(`[BOOKING SUCCESS] Table ${tableId} booked for ${metadata.booking_date
