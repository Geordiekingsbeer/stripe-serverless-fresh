import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
// Removed: import { Resend } from 'resend';

// const resend = new Resend(process.env.RESEND_API_KEY); // REMOVED THIS LINE

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const stripe = new Stripe(stripeSecretKey);
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// --- START: NEW DEBUG BLOCK ---
console.log('--- DEBUG: CLIENTS INITIALIZED SUCCESSFULLY ---');
console.log(`Tenant ID from Env: ${supabaseUrl.substring(8, 25)}...`);
// --- END: NEW DEBUG BLOCK ---


// --- Utility Functions and Webhook Handler Below ---

const getRawBody = (req) => {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
};

export default async (req, res) => {
    // 1. Check for Log in Vercel - If this is missing, the crash is in the code above (Initialization)
    console.log('--- DEBUG: WEBHOOK HANDLER STARTED ---'); 

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
        // Return 200 here to stop Stripe retries for verification issues
        return res.status(200).send(`Webhook Error: ${err.message}`); 
    }
    
    const eventId = event.id;
    const metadata = event.data.object.metadata || {};

    // 2. IDEMPOTENCY CHECK (Now the first Supabase call)
    const { data: existingEvent, error: selectError } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('stripe_event_id', eventId)
        .maybeSingle();

    if (selectError) {
        // If this logs, the RLS policy is still the problem.
        console.error('[IDEMPOTENCY FAILURE] Supabase Select Error:', selectError.message);
        // We return 500 to signal Stripe to retry, as this is a temporary DB error.
        return res.status(500).send(`Database Error: Could not check event ${eventId}`);
    } else if (existingEvent) {
        console.log(`[IDEMPOTENCY] Event ${eventId} already processed.`);
        return res.status(200).json({ received: true });
    }
    
    // 3. CRITICAL LOGGING (If we get here, initialization worked and select succeeded)
    console.log(`[DEBUG] Attempting to log new event: ${eventId}`);

    // ... The rest of your event processing logic (including the insert) will follow here
    // For this debug test, let's keep it minimal to confirm the successful log.

    if (event.type === 'checkout.session.completed') {
        // 4. LOG THE EVENT IMMEDIATELY
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
            // Return 500 to signal Stripe to retry
            return res.status(500).send(`Database Error: Could not log event ${eventId}`); 
        } else {
            console.log('[WEBHOOK_EVENTS SUCCESS] Event logged as processing. Success is confirmed.');
            // Stop here for the debug test to prevent failure later in the function
            return res.status(200).json({ received: true });
        }
    }

    // Default response for unhandled events
    return res.status(200).json({ received: true });
};
