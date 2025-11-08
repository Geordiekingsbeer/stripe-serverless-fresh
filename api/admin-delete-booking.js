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

### 2. Fix 2: Admin Frontend Update (`admin.html`)

This ensures your local Admin Page is calling the API correctly.

Find the `async function deleteBooking(bookingId) { ... }` function (around **line 796** in your provided code) and **replace the entire function** with the secure version below.

```javascript
// admin.html (~line 796) - REPLACE ENTIRE deleteBooking FUNCTION

async function deleteBooking(bookingId) {
    const tenantId = CURRENT_TENANT_ID; // Use the stored tenant ID
    // CRITICAL: URL for the secure deletion API (Match your actual Vercel domain)
    const deleteApiUrl = 'https://stripe-serverless-fresh.vercel.app/api/admin-delete-booking'; 

    const payload = {
        bookingId: bookingId,
        tenantId: tenantId
    };

    try {
        const response = await fetch(deleteApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        // We check response.ok and process the JSON result
        if (!response.ok) {
            const errorResult = await response.json();
            console.error('Admin Delete API Error:', errorResult.error || errorResult.details);
            alert('Admin deletion failed: ' + (errorResult.error || 'Check browser console for details.'));
            return false;
        }

        // SUCCESS: Reload the entire map data
        alert('Booking removed!');
        await loadBookings(); // This fetches the new, updated list and refreshes the map
        return true; 

    } catch (error) {
        alert('Network Error: Could not reach the deletion service.');
        console.error('Fetch Error:', error);
        return false;
    }
}
