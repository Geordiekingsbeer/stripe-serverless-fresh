// File: /api/admin-create-booking.js
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// --- ENV VARIABLES ---
const SUPABASE_URL = 'https://Rrjvdabtqzkaomjuiref.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Must be set in Vercel
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // Must be set in Vercel

const _supaAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', 'https://geordiekingsbeer.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { tableId, date, startTime, endTime, notes, tenantId, customerEmail } = req.body;

    if (!tableId || !date || !startTime || !endTime || !tenantId) {
      return res.status(400).json({ error: 'Missing required booking data.' });
    }

    // --- Insert booking into Supabase ---
    const newBooking = {
      table_id: tableId,
      date: date,
      start_time: startTime,
      end_time: endTime,
      host_notes: notes,
      tenant_id: tenantId,
      customer_email: customerEmail || null
    };

    const { data: insertedData, error: insertError } = await _supaAdmin
      .from('premium_slots')
      .insert([newBooking])
      .select('*');

    if (insertError) {
      console.error('Supabase insert failed:', insertError);
      return res.status(500).json({ error: 'Database insert failed. Check Vercel logs.' });
    }

    const booking = insertedData[0];

    // --- Create Stripe Checkout Session ---
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Booking Table ${booking.table_id} on ${booking.date} at ${booking.start_time}`,
            },
            unit_amount: 1000, // $10.00 example, adjust as needed
          },
          quantity: 1,
        },
      ],
      customer_email: booking.customer_email || undefined,
      metadata: { booking_id: booking.id },
      success_url: `https://geordiekingsbeer.github.io/booking-success?bookingId=${booking.id}`,
      cancel_url: `https://geordiekingsbeer.github.io/booking-cancel`,
    });

    // --- Update booking with Stripe Order ID ---
    await _supaAdmin
      .from('premium_slots')
      .update({ stripe_order_id: session.id })
      .eq('id', booking.id);

    // --- Respond with booking + Stripe URL ---
    return res.status(200).json({
      message: 'Booking created successfully!',
      data: booking,
      stripeCheckoutUrl: session.url,
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}
