import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// Initialize Supabase using the powerful Service Role Key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); 

export default async (req, res) => {
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
            return res.status(500).json({ error: 'Database delete failed.', details: error.message });
        }

        return res.status(200).json({ message: 'Booking successfully removed.' });

    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: 'Internal server error during deletion.' });
    }
};
```
***

### 2. Update `admin.html` (Front-end Call)

Now we change your Admin Page to call this new secure API instead of trying to delete the row directly from the browser.

Find the `async function deleteBooking(bookingId) { ... }` function (around **line 796**) and **replace the entire function** with this secure version.

```javascript
// admin.html (~line 796) - REPLACE ENTIRE deleteBooking FUNCTION

async function deleteBooking(bookingId) {
    const tenantId = CURRENT_TENANT_ID; // Use the stored tenant ID
    const deleteApiUrl = 'https://stripe-serverless-fresh.vercel.app/api/admin-delete-booking'; // IMPORTANT: Match your actual Vercel domain structure

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

        const result = await response.json();

        if (!response.ok) {
            alert('Admin deletion failed: ' + (result.error || 'Check Vercel logs for API error.'));
            console.error('Admin Delete API Error:', result.error || result.details);
            return false;
        }

        // SUCCESS: Reload the entire map data
        alert('Booking removed!');
        await loadBookings(); // This forces a data fetch and calls updateTableVisuals
        return true; 

    } catch (error) {
        alert('Network Error: Could not reach the deletion service.');
        console.error('Fetch Error:', error);
        return false;
    }
}
