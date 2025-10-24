import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Retrieve environment variables for Supabase access
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);


/**
 * Helper function to check for existing PAID bookings for selected tables
 * at the requested time slot using a Supabase Remote Procedure Call (RPC).
 */
async function checkBookingConflicts(tableIds, date, startTime, endTime) {
    const tableIdArray = tableIds.map(id => Number(id)); // Ensure IDs are numbers
    
    // Call the custom SQL function we created in Step 1
    const { data, error } = await supabase.rpc('check_overlap_for_checkout', {
        _table_ids: tableIdArray,
        _date: date,
        _start_time: startTime,
        _end_time: endTime
    });

    if (error) {
        console.error("RPC Conflict Check Failed:", error.message);
        // Fail safe: If the database check fails, we block the charge anyway.
        return true; 
    }

    // The RPC returns TRUE if a conflict exists.
    return data === true;
}


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
        
        // Calculate the end time for the conflict check (2 hours after start_time)
        const [hour, minute] = booking_time.split(':').map(Number);
        const endDate = new Date(booking_date + 'T' + booking_time + ':00');
        endDate.setHours(hour);
        endDate.setMinutes(minute + 120);
        
        const endH = String(endDate.getHours()).padStart(2, '0');
        const endM = String(endDate.getMinutes()).padStart(2, '0');
        const calculatedEndTime = `${endH}:${endM}`;


        // --- CRITICAL: PRE-CHECKOUT CONFLICT VALIDATION ---
        const isConflict = await checkBookingConflicts(table_ids, booking_date, booking_time, calculatedEndTime);

        if (isConflict) {
            console.warn(`Checkout blocked: Table already booked at ${booking_date} ${booking_time}.`);
            // Return 409 Conflict status and redirect the customer back to the map
            return res.status(409).json({ 
                error: 'Conflict: The selected table is no longer available. Please refresh the map.',
                status: 'conflict'
            });
        }
        // --- END VALIDATION ---

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
            // Redirect customer back to the map with a conflict flag if session creation fails
            cancel_url: `https://book.dineselect.co/pick-seat.html?tenant_id=${tenant_id}&conflict=true`,    
        });

        return res.status(200).json({ url: session.url });

    } catch (error) {
        console.error('Stripe Checkout Creation Error:', error);
        return res.status(500).json({ error: 'Internal Server Error during checkout creation.' });
    }
};
