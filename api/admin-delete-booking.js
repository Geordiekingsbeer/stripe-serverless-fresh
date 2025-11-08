import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// Initialize Supabase using the powerful Service Role Key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); 

export default async (req, res) => {
    // CRITICAL: Allow CORS access from the front end
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        // Data destructured from the front-end request body
        const { bookingId, tenantId } = req.body;
        
        if (!bookingId || !tenantId) {
            return res.status(400).json({ error: 'Missing bookingId or tenantId.' });
        }

        // Perform the deletion using the Service Role Key
        const { error } = await supabase
            .from('premium_slots')
            .delete()
            .eq('id', bookingId)
            .eq('tenant_id', tenantId);

        if (error) {
            console.error('SERVER DELETE FAILED:', error);
            // Include details in the response for debugging in the browser console
            return res.status(500).json({ error: 'Database delete failed.', details: error.message });
        }

        return res.status(200).json({ message: 'Booking successfully removed.' });

    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: 'Internal server error during deletion.' });
    }
};
```

### Action 2: Verify Admin Panel Client Code (No Change Needed)

The `deleteBooking` function in your **`admin.html`** file is already correctly set up to call the Vercel API endpoint. Once the Vercel file stops crashing, your Admin Panel will automatically succeed on deletion and refresh the map.

**Verification of `deleteBooking` in `admin.html` (Current State - No Change Needed):**

```javascript
// admin.html (~line 796)
async function deleteBooking(bookingId) {
    const tenantId = CURRENT_TENANT_ID; 
    const deleteApiUrl = 'https://stripe-serverless-fresh.vercel.app/api/admin-delete-booking'; 
    // ... (rest of the API call logic)
}
