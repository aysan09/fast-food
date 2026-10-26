require('dotenv').config();

module.exports = async function run(page, ui) {
    const out = [];

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('http://localhost:3000/#/login?role=cashier');
    await page.waitForSelector('#staff-password', { timeout: 15000 });
    await page.fill('#staff-email', process.env.CASHIER_EMAIL || 'cashier@sebacafe.et');
    await page.fill('#staff-password', process.env.CASHIER_PASSWORD || '');
    await page.click('#staff-login-form button[type="submit"]');
    await page.waitForTimeout(2500);
    out.push({ afterLogin: page.url() });

    for (const [hash, file] of [
        ['#/cashier/report?range=week', '_groups.png'],
        ['#/cashier/report?range=all', '_all.png']
    ]) {
        await page.goto(`http://localhost:3000/${hash}`);
        await page.waitForTimeout(1800);
        await page.screenshot({ path: `c:/Users/user/Downloads/seba-cafe/seba-cafe/${file}`, fullPage: false });
        out.push({ file, url: page.url() });
    }

    // Confirm the grouping actually produced day headings.
    const headings = await page.$$eval('.cashier-day-heading strong', els => els.map(e => e.textContent));
    const totals = await page.$$eval('.cashier-day-heading > span', els => els.map(e => e.textContent));
    return { out, headings, totals };
};
