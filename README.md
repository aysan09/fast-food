# EMBER KITCHEN

Node.js, Express, MySQL, and Socket.IO restaurant ordering portal. Customer orders and prices are validated by the server. Customers can pay by manual Telebirr/CBE transfer with receipt review, cash at the counter, or a Chapa phone prompt.

## Setup

1. Install Node.js 22 or later and MySQL 8.
2. Copy `.env.example` to `.env` and set the MySQL connection values.
3. Install dependencies and create the database/seed data:

   ```text
   npm install
   npm run db:init
   ```

4. Set distinct passwords for the admin, cashier, and waiter accounts. The server creates or updates these staff accounts at startup. In development, an unset `SESSION_SECRET` is generated ephemerally; staff sessions reset on restart. Production requires an explicit random `SESSION_SECRET` of at least 32 characters.
5. Set `CHAPA_SECRET_KEY` to a Chapa test secret from the merchant dashboard. Keep this value only in `.env` on the server.
6. Set `PUBLIC_BASE_URL` to the public HTTPS origin that serves this app. Localhost is fine for browsing, but Chapa cannot call a localhost callback. For local payment tests, expose the Node server through an HTTPS tunnel and use that tunnel URL here.
7. Configure the same random webhook secret in Chapa’s webhook settings and `CHAPA_WEBHOOK_SECRET`. Register `https://<your-public-host>/api/payments/webhook` as the webhook URL.
8. Set `BANK_ACCOUNT_NAME`, `TELEBIRR_ACCOUNT`, and `CBE_ACCOUNT` to the restaurant’s customer-facing transfer details. Leave an unused destination blank.
9. Start the app:

   ```text
   npm install
   npm start
   ```

Open `http://localhost:3000`. Use the staff emails/passwords set in `.env` to enter the protected workspaces. For real payments, replace the test secret with the merchant’s live secret only after end-to-end testing.

## Payment flow

- The browser submits menu item IDs and quantities; the server reloads prices and availability from MySQL and computes the total.
- Digital orders are initialized through Chapa’s Direct Charges API using the chosen mobile-money channel, phone number, and server-generated transaction reference. Chapa sends the customer an authorization prompt.
- The customer return screen polls `GET /api/orders/public/:token` while the prompt is pending. The signed webhook causes the server to verify the transaction with Chapa; the order advances to `paid` and `in_kitchen` only when reference, ETB amount, and currency match the database order.
- Successful verification emits `order_paid` and `order_status_updated` to staff dashboards through Socket.IO.
- Cash orders remain pending until a cashier explicitly confirms cash receipt.
- Manual transfer orders require an uploaded JPG, PNG, or WebP receipt (up to 5 MB). The image is stored in `uploads/payment-receipts` and is served only to signed-in cashiers and admins. Cashiers compare the receipt with the bank notification, then approve it into the kitchen or reject it with an optional reason.
- Configure restaurant transfer account details in `.env`; these values are public checkout instructions, not payment credentials.

## API

- `GET /api/menu-items`
- `POST /api/orders`
- `POST /api/payments/initialize`
- `GET /api/payments/callback`
- `POST /api/payments/webhook`
- `GET /api/orders/public/:token`
- `GET /api/payment-details`
- `GET /api/admin/overview`, `GET /api/admin/tables`, and `GET /api/admin/menu-items` (admin session)
- `POST /api/admin/menu-items` and `PATCH /api/admin/menu-items/:id/availability` (admin session)
- `GET /api/cashier/orders` (optional `?status=pending_approval`) and `PATCH /api/cashier/orders/:id/approve` (cashier/admin session)
- `PATCH /api/cashier/orders/:id/verify-payment` and `GET /api/cashier/orders/:id/receipt` (cashier/admin session)
- `PATCH /api/cashier/orders/:id/advance` (cashier/admin session)

Run the payment signature/parity tests with `npm test`.
