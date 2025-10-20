import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendBookingNotification(booking, type) {
    const staffEmail = 'geordie.kingsbeer@gmail.com';
    const senderEmail = 'onboarding@resend.dev'; 

    const subject = `[NEW BOOKING - ${type}] Table ${booking.table_id} on ${booking.date}`;
    const body = `
        <p>A new <b>${type}</b> booking has been confirmed for <b>${booking.tenant_id}</b>!</p>
        <p><strong>Customer:</strong> ${booking.customer_name || 'Manual Admin Booking'}</p>
        <ul>
            <li><strong>Table ID:</strong> ${booking.table_id}</li>
            <li><strong>Date:</strong> ${booking.date}</li>
            <li><strong>Time:</strong> ${booking.start_time} - ${booking.end_time}</li>
            <li><strong>Source:</strong> ${type}</li>
            <li><strong>Notes:</strong> ${booking.host_notes || 'None'}</li>
            <li><strong>Customer Email:</strong> N/A (Staff Booked)</li>
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
            customer_email: 'admin_booked@yourrestaurant.com', // Keep placeholder in DB for record integrity
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
        
        // Prepare notification payload with clean email/name for staff view
        const adminBookingNotification = {
            ...booking,
            customer_email: 'N/A (Staff Booked)', // Override email in payload only
            customer_name: 'Manual Admin Booking',
        };
        
        await sendBookingNotification(adminBookingNotification, 'ADMIN MANUAL');

        return res.status(200).json({
            message: 'Admin booking created and confirmed successfully.',
            data: booking,
        });

    } catch (err) {
        console.error('Server error:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
