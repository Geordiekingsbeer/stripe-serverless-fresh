import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
            cancel_url: `https://book.dineselect.co/pick-seat.html`, 
        });

        return res.status(200).json({ url: session.url });

    } catch (error) {
        console.error('Stripe Checkout Creation Error:', error);
        return res.status(500).json({ error: 'Internal Server Error during checkout creation.' });
    }
};
