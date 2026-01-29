const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const session = require('express-session');
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public')); // Servir archivos estáticos (imágenes)
app.use(session({
    secret: process.env.SESSION_SECRET || 'mi_secreto_super_seguro_cambialo',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using https in production
}));

// Middleware de Autenticación
const requireAuth = (req, res, next) => {
    if (req.session && req.session.isLoggedIn) {
        return next();
    } else {
        res.redirect('/login');
    }
};

// --- RUTAS DE LOGIN ---

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USER;
    const adminPass = process.env.ADMIN_PASSWORD;

    if (username === adminUser && password === adminPass) {
        req.session.isLoggedIn = true;
        res.redirect('/');
    } else {
        res.render('login', { error: 'Credenciales inválidas' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});


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

        await pool.query(`ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS shopify_price_rule_id VARCHAR(50)`);
        console.log("✅ Columna shopify_price_rule_id verificada.");
    } catch (err) {
        console.error("❌ Error en base de datos:", err);
    }
};
initDB();



app.get('/', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM affiliates ORDER BY created_at DESC');
        res.render('index', { affiliates: result.rows, path: '/' });
    } catch (err) {
        res.send("Error cargando afiliados: " + err.message);
    }
});

app.post('/create-affiliate', requireAuth, async (req, res) => {
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
            'INSERT INTO affiliates (name, email, shopify_code, discount_percent, commission_percent, shopify_price_rule_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [name, email, code, discount, commission, priceRuleId]
        );

        res.redirect('/');

    } catch (error) {
        console.error(error.response ? error.response.data : error.message);
        res.send("Error creando cupón en Shopify. Revisa los logs.");
    }
});


// --- NUEVAS RUTAS: Eliminar y Sincronizar ---

app.post('/delete/:id', requireAuth, async (req, res) => {
    const affiliateId = req.params.id;
    try {
        // 1. Obtener ID de Shopify de la DB
        const result = await pool.query('SELECT shopify_price_rule_id FROM affiliates WHERE id = $1', [affiliateId]);
        if (result.rows.length === 0) return res.send("Afiliado no encontrado");

        const shopifyPriceRuleId = result.rows[0].shopify_price_rule_id;

        // 2. Borrar de Shopify si tenemos ID
        if (shopifyPriceRuleId) {
            const shopifyUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/price_rules/${shopifyPriceRuleId}.json`;
            const shopifyHeader = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };

            try {
                await axios.delete(shopifyUrl, { headers: shopifyHeader });
                console.log(`✅ Cupón eliminado de Shopify: ${shopifyPriceRuleId}`);
            } catch (shopifyErr) {
                console.error("⚠️ Error borrando de Shopify (puede que ya no exista):", shopifyErr.message);
                // Continuamos para borrar de DB local de todas formas
            }
        }

        // 3. Borrar de DB Local
        await pool.query('DELETE FROM affiliates WHERE id = $1', [affiliateId]);
        console.log(`✅ Afiliado eliminado de DB local: ID ${affiliateId}`);

        res.redirect('/');
    } catch (error) {
        console.error("Error eliminando afiliado:", error);
        res.send("Error eliminando afiliado: " + error.message);
    }
});

app.get('/sync', requireAuth, async (req, res) => {
    try {
        console.log("🔄 Iniciando sincronización espejo desde Shopify...");
        const shopifyUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/price_rules.json`;
        const shopifyHeader = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };

        const response = await axios.get(shopifyUrl, { headers: shopifyHeader });
        const priceRules = response.data.price_rules;

        // Crear Set de IDs activos en Shopify para búsqueda rápida
        const activeShopifyIds = new Set(priceRules.map(r => String(r.id)));

        // 1. ELIMINAR locales que ya no existen en Shopify
        const localAffiliates = await pool.query('SELECT id, shopify_price_rule_id FROM affiliates');
        let deletedCount = 0;

        for (const affiliate of localAffiliates.rows) {
            // Si tiene ID de shopify y ese ID no está en el Set de activos -> Eliminar
            if (affiliate.shopify_price_rule_id && !activeShopifyIds.has(String(affiliate.shopify_price_rule_id))) {
                await pool.query('DELETE FROM affiliates WHERE id = $1', [affiliate.id]);
                console.log(`🗑️ Eliminado localmente (no existe en Shopify): ID ${affiliate.id}`);
                deletedCount++;
            }
        }

        // 2. UPSERT (Insertar o Actualizar) desde Shopify
        for (const rule of priceRules) {
            const shopifyId = rule.id;
            const code = rule.title;
            const discountValue = Math.abs(parseFloat(rule.value));

            await pool.query(`
                INSERT INTO affiliates (name, email, shopify_code, discount_percent, commission_percent, shopify_price_rule_id, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'active')
                ON CONFLICT (shopify_code) 
                DO UPDATE SET 
                    shopify_price_rule_id = EXCLUDED.shopify_price_rule_id,
                    discount_percent = EXCLUDED.discount_percent,
                    status = 'active'
            `, [
                code,
                '',
                code,
                discountValue,
                10,
                shopifyId
            ]);
        }
        console.log(`✅ Sincronización completada. Activos: ${priceRules.length}, Eliminados locales: ${deletedCount}`);
        res.redirect('/');
    } catch (error) {
        console.error("Error en sincronización:", error);
        res.send("Error sincronizando: " + error.message);
    }
});

// --- RUTA DE VENTAS ---
app.get('/sales', requireAuth, async (req, res) => {
    try {
        const { start, end } = req.query;
        let shopifyUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/orders.json?status=any&limit=250`;

        // Agregar filtro de fecha si existe
        if (start) {
            shopifyUrl += `&created_at_min=${new Date(start).toISOString()}`;
        }
        if (end) {
            // Ajustar end date para incluir todo el día
            const endDate = new Date(end);
            endDate.setHours(23, 59, 59, 999);
            shopifyUrl += `&created_at_max=${endDate.toISOString()}`;
        }

        const shopifyHeader = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };
        const response = await axios.get(shopifyUrl, { headers: shopifyHeader });
        const orders = response.data.orders;

        // Obtener códigos de afiliados para calcular comisiones
        const affiliatesResult = await pool.query('SELECT shopify_code, commission_percent FROM affiliates');
        const affiliatesMap = new Map();
        affiliatesResult.rows.forEach(a => {
            affiliatesMap.set(a.shopify_code, parseFloat(a.commission_percent));
        });

        // Procesar ordenes para la vista
        const sales = orders.map(order => {
            const discountCode = (order.discount_codes && order.discount_codes.length > 0) ? order.discount_codes[0].code : null;
            let commission = 0;

            if (discountCode && affiliatesMap.has(discountCode)) {
                const percent = affiliatesMap.get(discountCode);
                commission = parseFloat(order.total_price) * (percent / 100);
            }

            return {
                order_number: order.order_number,
                created_at: order.created_at,
                customer: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : 'Invitado',
                total_price: parseFloat(order.total_price),
                discount_code: discountCode,
                commission: commission
            };
        });

        const totalSales = sales.reduce((acc, curr) => acc + curr.total_price, 0);

        // Agregación por Cupón
        const couponStatsMap = new Map();

        sales.forEach(sale => {
            if (sale.discount_code) {
                if (!couponStatsMap.has(sale.discount_code)) {
                    couponStatsMap.set(sale.discount_code, {
                        code: sale.discount_code,
                        count: 0,
                        totalSales: 0,
                        totalCommission: 0
                    });
                }
                const stats = couponStatsMap.get(sale.discount_code);
                stats.count += 1;
                stats.totalSales += sale.total_price;
                stats.totalCommission += sale.commission;
            }
        });

        const couponStats = Array.from(couponStatsMap.values());

        res.render('sales', {
            sales,
            path: '/sales',
            startDate: start || '',
            endDate: end || '',
            totalSales,
            couponStats
        });
    } catch (error) {
        console.error("Error cargando ventas:", error);
        res.send("Error cargando reporte de ventas: " + error.message);
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
