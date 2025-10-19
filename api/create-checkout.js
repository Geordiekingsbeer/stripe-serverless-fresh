const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
    // 1. Handle non-POST methods (OPTIONS is handled by vercel.json)
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        // 2. Destructure only essential data for a simple test
        const { 
            table_ids, 
            email, 
            total_pence, 
            booking_date, 
            booking_time 
        } = req.body;
        
        // Basic validation
        if (!table_ids || total_pence <= 0 || !email) {
            return res.status(400).json({ error: 'Missing required data: tables, price, or email.' });
        }
        
        // 3. Create the Line Item with minimal description
        const lineItem = {
            price_data: {
                currency: 'gbp', 
                product_data: {
                    name: `Table Reservation (Test - ${table_ids.length} table${table_ids.length > 1 ? 's' : ''})`,
                    description: `Date: ${booking_date} | Time: ${booking_time}`,
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
            
            // TEMPORARILY REDUCED METADATA
            metadata: {
                table_ids: table_ids.join(','),
                tenant_id: req.body.tenant_id, // Keep only critical reference IDs
            },

            // SIMPLIFIED SUCCESS/CANCEL URLs
            // Use your GitHub Pages URL structure directly.
            success_url: `https://geordiekingsbeer.github.io/table-picker/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://geordiekingsbeer.github.io/table-picker/pick-seat.html`, 
        });

        // 5. Respond with the Stripe Checkout URL
        res.status(200).json({ url: session.url });

    } catch (error) {
        // LOG THE ERROR DETAILS to Vercel Logs
        console.error('Stripe Checkout Creation ERROR:', error.message);
        
        // Return a generic 500 error to the client
        res.status(500).json({ error: 'Internal Server Error. Check Vercel logs for details.' });
    }
};
