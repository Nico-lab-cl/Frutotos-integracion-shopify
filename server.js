const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : false
});

const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS affiliates (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(150),
                shopify_code VARCHAR(50) UNIQUE NOT NULL,
                discount_percent DECIMAL(5,2) NOT NULL, 
                commission_percent DECIMAL(5,2) NOT NULL,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Tabla de afiliados verificada/creada.");
    } catch (err) {
        console.error("❌ Error en base de datos:", err);
    }
};
initDB();

app.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM affiliates ORDER BY created_at DESC');
        res.render('index', { affiliates: result.rows });
    } catch (err) {
        res.send("Error cargando afiliados: " + err.message);
    }
});

app.post('/create-affiliate', async (req, res) => {
    const { name, email, code, discount, commission } = req.body;
    try {
        const shopifyPayload = {
            price_rule: {
                title: code,
                target_type: "line_item",
                target_selection: "all",
                allocation_method: "across",
                value_type: "percentage",
                value: `-${discount}.0`,
                customer_selection: "all",
                starts_at: new Date().toISOString()
            }
        };

        const shopifyUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/price_rules.json`;
        const shopifyHeader = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };
        
        const responseRule = await axios.post(shopifyUrl, shopifyPayload, { headers: shopifyHeader });
        const priceRuleId = responseRule.data.price_rule.id;

        await axios.post(
            `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/price_rules/${priceRuleId}/discount_codes.json`,
            { discount_code: { code: code } },
            { headers: shopifyHeader }
        );

        await pool.query(
            'INSERT INTO affiliates (name, email, shopify_code, discount_percent, commission_percent) VALUES ($1, $2, $3, $4, $5)',
            [name, email, code, discount, commission]
        );

        res.redirect('/');

    } catch (error) {
        console.error(error.response ? error.response.data : error.message);
        res.send("Error creando cupón en Shopify. Revisa los logs.");
    }
});

app.post('/webhooks/orders/create', async (req, res) => {
    const order = req.body;
    if (order.discount_codes && order.discount_codes.length > 0) {
        const usedCode = order.discount_codes[0].code;
        const result = await pool.query('SELECT * FROM affiliates WHERE shopify_code = $1', [usedCode]);
        
        if (result.rows.length > 0) {
            const atleta = result.rows[0];
            const totalVenta = parseFloat(order.total_price);
            const comision = totalVenta * (atleta.commission_percent / 100);
            console.log(`💰 Comisión generada para ${atleta.name}: $${comision}`);
        }
    }
    res.status(200).send('Webhook Recibido');
});

app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});
