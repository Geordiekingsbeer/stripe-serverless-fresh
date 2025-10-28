import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); 


/**
 * Helper function to convert time string (HH:MM) to minutes past midnight.
 */
function timeToMinutes(timeStr) {
    const parts = timeStr.split(':').map(Number);
    return (parts[0] * 60) + parts[1];
}


/**
 * Helper function to calculate the booking end time (2 hours later).
 */
function calculateBookingEndTime(bookingDate, startTime) {
    const [hour, minute] = startTime.split(':').map(Number);
    
    // Create a Date object for the booking start time
    const bookingDateTimeLocal = new Date(`${bookingDate}T${startTime}:00`);

    // Add 2 hours (120 minutes)
    bookingDateTimeLocal.setMinutes(bookingDateTimeLocal.getMinutes() + 120); 

    const endH = String(bookingDateTimeLocal.getHours()).padStart(2, '0');
    const endM = String(bookingDateTimeLocal.getMinutes()).padStart(2, '0');
    
    return `${endH}:${endM}`;
}


/**
 * Helper function to create a new reservation hold for 5 minutes.
 * Now checks for actual time-slot conflicts.
 */
async function createReservationHold(tableIds, tenantId, bookingRef, bookingDate, startTime, endTime) {
    const tableIdArray = tableIds.map(id => Number(id));
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    
    // Convert new booking times to minutes
    const newBookingStartMinutes = timeToMinutes(startTime);
    const newBookingEndMinutes = timeToMinutes(endTime);

    // 1. Fetch all currently active holds for the selected date and tables
    const { data: activeHolds, error: checkError } = await supabase
        .from('reserved_holds')
        .select('table_id, start_time, end_time') // Select time columns for comparison
        .in('table_id', tableIdArray)
        .eq('date', bookingDate) // CRITICAL: Check against the specific date
        .gte('expires_at', new Date().toISOString()); // Only active holds

    if (checkError) {
        console.error("Hold Check Error:", checkError.message);
        return { isConflict: true };
    }
    
    // 2. Client-side filter: Check for actual time overlap
    const conflictingHold = activeHolds.find(hold => {
        const holdStartMinutes = timeToMinutes(hold.start_time);
        const holdEndMinutes = timeToMinutes(hold.end_time);

        // Standard time overlap check: (StartA < EndB) AND (EndA > StartB)
        const overlaps = (newBookingStartMinutes < holdEndMinutes) && 
                         (newBookingEndMinutes > holdStartMinutes);
        
        return overlaps;
    });


    if (conflictingHold) {
        // Conflict found: A table is actively held for the specific time slot.
        return { isConflict: true, conflictingTableId: conflictingHold.table_id };
    }

    // 3. No conflict, proceed to create hold records
    const holdRecords = tableIdArray.map(id => ({
        table_id: id,
        tenant_id: tenantId,
        expires_at: fiveMinutesFromNow,
        booking_ref: bookingRef,
        date: bookingDate, 
        start_time: startTime, 
        end_time: endTime, 
    }));

    const { error: insertError } = await supabase
        .from('reserved_holds')
        .insert(holdRecords);

    if (insertError) {
        console.error("Hold Insert Error:", insertError.message);
        return { isConflict: true };
    }

    console.log(`Successfully placed 5-minute time-specific hold on tables: ${tableIds.join(',')} for ${bookingDate}`);
    return { isConflict: false, expiresAt: fiveMinutesFromNow };
}


export default async (req, res) => {
    // ... (CORS setup code) ...
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
        
        // --- Input Validation ---
        if (!table_ids || total_pence <= 0 || !email) {
            return res.status(400).json({ error: 'Missing required data: tables, price, or email.' });
        }
        
        // Calculate the 2-hour end time for the hold record
        const calculatedEndTime = calculateBookingEndTime(booking_date, booking_time);

        // --- CRITICAL STEP: PLACE 5-MINUTE TIME-SPECIFIC HOLD ---
        const holdResult = await createReservationHold(
            table_ids, 
            tenant_id, 
            booking_ref, 
            booking_date, 
            booking_time, 
            calculatedEndTime
        );

        if (holdResult.isConflict) {
            console.warn(`Checkout blocked by Hold: Table ${holdResult.conflictingTableId || 'N/A'} is currently held.`);
            // Return 409 Conflict status and redirect the customer back to the map
            return res.status(409).json({ 
                error: `Hold Conflict: The selected table is now reserved. Please refresh the map.`,
                status: 'hold_conflict'
            });
        }
        // --- END HOLD ---

        // --- Define Stripe Line Item ---
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
        // --- End Line Item Definition ---

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [lineItem],
            mode: 'payment',
            customer_email: email,    
            
            metadata: {
                table_ids: table_ids.join(','),
                booking_date: booking_date,
                booking_time: booking_time,
                booking_end_time: calculatedEndTime, 
                customer_name: customer_name,
                party_size: party_size.toString(),
                tenant_id: tenant_id,
                booking_ref: booking_ref || 'N/A',
                receive_offers: receive_offers ? 'TRUE' : 'FALSE',
                email: email
            },

            success_url: `https://book.dineselect.co/success.html?session_id={CHECKOUT_SESSION_ID}&tenant_id=${tenant_id}&booking_ref=${booking_ref}`,
            cancel_url: `https://book.dineselect.co/select-table.html?tenant_id=${tenant_id}&conflict=true`,    
        });

        return res.status(200).json({ url: session.url });

    } catch (error) {
        console.error('Stripe Checkout Creation Error:', error);
        return res.status(500).json({ error: 'Internal Server Error during checkout creation.' });
    }
};
