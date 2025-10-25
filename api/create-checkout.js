import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Retrieve environment variables for Supabase access
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// Initialize Supabase client for checks and holds
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); 


/**
 * Helper function to create a new reservation hold for 10 minutes.
 * Also checks if the table is currently held by someone else.
 */
async function createReservationHold(tableIds, tenantId, bookingRef) {
    const tableIdArray = tableIds.map(id => Number(id));
    const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    
    // 1. Check for CURRENT active holds for any of the selected tables
    const { data: existingHolds, error: checkError } = await supabase
        .from('reserved_holds')
        .select('table_id')
        .in('table_id', tableIdArray)
        .gte('expires_at', new Date().toISOString()) // Check if expiration is in the future
        .limit(1);

    if (checkError) {
        console.error("Hold Check Error:", checkError.message);
        return { isConflict: true };
    }
    
    if (existingHolds && existingHolds.length > 0) {
        // Conflict found: Table is held by another customer
        return { isConflict: true, conflictingTableId: existingHolds[0].table_id };
    }

    // 2. No conflict, proceed to create hold records
    const holdRecords = tableIdArray.map(id => ({
        table_id: id,
        tenant_id: tenantId,
        expires_at: tenMinutesFromNow,
        booking_ref: bookingRef,
    }));

    const { error: insertError } = await supabase
        .from('reserved_holds')
        .insert(holdRecords);

    if (insertError) {
        console.error("Hold Insert Error:", insertError.message);
        return { isConflict: true };
    }

    console.log(`Successfully placed 10-minute hold on tables: ${tableIds.join(',')}`);
    return { isConflict: false, expiresAt: tenMinutesFromNow };
}


// NOTE: checkBookingConflicts logic has been removed as this new function replaces it.

export default async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://book.dineselect.co');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const {    
            table_ids,    
            email,    
            booking_date,    
            booking_time,    
            total_pence,    
            customer_name,    
            party_size,    
            tenant_id,    
            booking_ref,
            receive_offers
        } = req.body;
        
        if (!table_ids || total_pence <= 0 || !email) {
            return res.status(400).json({ error: 'Missing required data: tables, price, or email.' });
        }
        
        // --- CRITICAL STEP: PLACE 10-MINUTE HOLD ---
        const holdResult = await createReservationHold(table_ids, tenant_id, booking_ref);

        if (holdResult.isConflict) {
            console.warn(`Checkout blocked by Hold: Table ${holdResult.conflictingTableId || 'N/A'} is currently held or database error occurred.`);
            // Return 409 Conflict status and redirect the customer back to the map
            return res.status(409).json({ 
                error: `Hold Conflict: The selected table is now reserved. Please refresh the map.`,
                status: 'hold_conflict'
            });
        }
        // --- END HOLD ---

        const lineItem = {
            price_data: {
                currency: 'gbp',    
                product_data: {
                    name: `Premium Table Reservation (${table_ids.length} Table${table_ids.length > 1 ? 's' : ''})`,
                    description: `Tables: ${table_ids.join(', ')} | Date: ${booking_date} | Time: ${booking_time}.`,
                },
                unit_amount: total_pence,    
            },
            quantity: 1,
        };

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [lineItem],
            mode: 'payment',
            customer_email: email,    
            
            metadata: {
                table_ids: table_ids.join(','),
                booking_date: booking_date,
                booking_time: booking_time,
                customer_name: customer_name,
                party_size: party_size.toString(),
                tenant_id: tenant_id,
                booking_ref: booking_ref || 'N/A',
                receive_offers: receive_offers ? 'TRUE' : 'FALSE',
                email: email
            },

            success_url: `https://book.dineselect.co/success.html?session_id={CHECKOUT_SESSION_ID}&tenant_id=${tenant_id}&booking_ref=${booking_ref}`,
            // Redirect customer back to the map with a flag if session creation fails
            cancel_url: `https://book.dineselect.co/pick-seat.html?tenant_id=${tenant_id}&conflict=true`,    
        });

        return res.status(200).json({ url: session.url });

    } catch (error) {
        console.error('Stripe Checkout Creation Error:', error);
        return res.status(500).json({ error: 'Internal Server Error during checkout creation.' });
    }
};
