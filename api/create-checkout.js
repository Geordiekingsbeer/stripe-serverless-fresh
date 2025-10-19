import Stripe from 'stripe'; 
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
    // 1. Handle non-POST methods (OPTIONS is handled by vercel.json)
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        // 2. Destructure the data sent from the client
        const { 
            table_ids, 
            email, 
            booking_date, 
            booking_time, 
            total_pence, 
            customer_name, 
            party_size, 
            tenant_id, 
            booking_ref 
        } = req.body;
        
        // Basic validation
        if (!table_ids || total_pence <= 0 || !email) {
            return res.status(400).json({ error: 'Missing required data: tables, price, or email.' });
        }
        
        // 3. Create the Line Item
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

        // 4. Create the Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [lineItem],
            mode: 'payment',
            customer_email: email, 
            
            // Pass necessary data to the webhook via metadata
            metadata: {
                table_ids: table_ids.join(','),
                booking_date: booking_date,
                booking_time: booking_time,
                customer_name: customer_name,
                party_size: party_size.toString(),
                tenant_id: tenant_id,
                booking_ref: booking_ref || 'N/A', 
            },

            // NOTE: Using the known client path for success/cancel
            success_url: `https://geordiekingsbeer.github.io/table-picker/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://geordiekingsbeer.github.io/table-picker/pick-seat.html`, 
        });

        // 5. Respond with the Stripe Checkout URL
        res.status(200).json({ url: session.url });

    } catch (error) {
        console.error('Stripe Checkout Creation Error:', error);
        res.status(500).json({ error: 'Internal Server Error during checkout creation.' });
    }
};
