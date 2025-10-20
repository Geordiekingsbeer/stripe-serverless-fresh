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
        Notes: ${booking.host_notes || 'None'}
        Customer Email: ${booking.customer_email || 'N/A'}
        
        -- SENT VIA VERCEL SERVERLESS FUNCTION --
    `;
    
    console.log(`Email Mock: Sending to ${staffEmail}. Subject: ${subject}`);
    return { success: true };
}

const SUPABASE_URL = 'https://Rrjvdabtqzkaomjuiref.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _supaAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://geordiekingsbeer.github.io');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const { tableId, date, startTime, endTime, notes, tenantId } = req.body;

        if (!tableId || !date || !startTime || !endTime || !tenantId) {
            return res.status(400).json({ error: 'Missing required booking data.' });
        }

        const newBooking = {
            table_id: tableId,
            date: date,
            start_time: startTime,
            end_time: endTime,
            host_notes: notes || 'Manual Admin Booking',
            tenant_id: tenantId,
            customer_email: 'admin_booked@yourrestaurant.com',
            payment_status: 'PAID',
            is_manual_booking: true
        };

        const { data: insertedData, error: insertError } = await _supaAdmin
            .from('premium_slots')
            .insert([newBooking])
            .select('*');

        if (insertError) {
            console.error('Supabase insert failed:', insertError);
            if (insertError.code === '23505') {
                 return res.status(409).json({ error: 'Table is already booked during this time slot (Database Conflict).' });
            }
            return res.status(500).json({ error: 'Database insert failed. Check Vercel logs.' });
        }

        const booking = insertedData[0];
        
        // Send Email Notification for Admin Booking
        await sendBookingNotification(booking, 'ADMIN MANUAL');

        return res.status(200).json({
            message: 'Admin booking created and confirmed successfully.',
            data: booking,
        });

    } catch (err) {
        console.error('Server error:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
