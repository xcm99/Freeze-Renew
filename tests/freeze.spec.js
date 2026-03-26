// tests/freeze.spec.js
const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

const tokensInput = process.env.DISCORD_TOKEN || '';
const tokens = tokensInput.split(',').map(t => t.trim()).filter(Boolean);
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }

        const msg = [
            `🎮 FreezeHost 续期报告`,
            `🕐 时间: ${nowStr()}`,
            `========================`,
            `${result}`,
            `🌐 官网入口: https://free.freezehost.pro`
        ].join('\n');

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) {
                console.log('📨 TG 推送成功');
            } else {
                console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', (e) => {
            console.log(`⚠️ TG 推送异常：${e.message}`);
            resolve();
        });

        req.setTimeout(15000, () => {
            console.log('⚠️ TG 推送超时');
            req.destroy();
            resolve();
        });

        req.write(body);
        req.end();
    });
}

async function handleOAuthPage(page) {
    console.log(`  📄 当前 URL: ${page.url()}`);
    await page.waitForTimeout(3000);

    const selectors = [
        'button:has-text("Authorize")',
        'button:has-text("授权")',
        'button[type="submit"]',
        'div[class*="footer"] button',
        'button[class*="primary"]',
    ];

    for (let i = 0; i < 8; i++) {
        console.log(`  🔄 第 ${i + 1} 次尝试，URL: ${page.url()}`);

        if (!page.url().includes('discord.com')) {
            console.log('  ✅ 已离开 Discord');
            return;
        }

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);

        for (const selector of selectors) {
            try {
                const btn = page.locator(selector).last();
                const visible = await btn.isVisible();
                if (!visible) continue;

                const text = (await btn.innerText()).trim();
                console.log(`  🔘 找到按钮: "${text}" (${selector})`);

                if (text.includes('取消') || text.toLowerCase().includes('cancel') ||
                    text.toLowerCase().includes('deny')) continue;

                const disabled = await btn.isDisabled();
                if (disabled) {
                    console.log('  ⏳ 按钮 disabled，等待...');
                    break;
                }

                await btn.click();
                console.log(`  ✅ 已点击: "${text}"`);
                await page.waitForTimeout(2000);

                if (!page.url().includes('discord.com')) {
                    console.log('  ✅ 授权成功，已跳转');
                    return;
                }
                break;
            } catch { continue; }
        }

        await page.waitForTimeout(2000);
    }

    console.log(`  ⚠️ handleOAuthPage 结束，URL: ${page.url()}`);
}

test('FreezeHost 自动续期', async ({}, testInfo) => {
    if (tokens.length === 0) {
        throw new Error('❌ 缺少 DISCORD_TOKEN 环境变量，请配置');
    }

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        try {
            const http = require('http');
            await new Promise((resolve, reject) => {
                const req = http.request(
                    { host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 },
                    () => resolve()
                );
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: process.env.GOST_PROXY };
            console.log('🛡️ 本地代理连通，使用 GOST 转发');
        } catch {
            console.log('⚠️ 本地代理不可达，降级为直连');
        }
    }

    console.log(`🔧 启动浏览器 (共需处理 ${tokens.length} 个账号)...`);
    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
    });

    try {
        // ── 出口 IP 验证（仅测一次） ─────────────────────────
        console.log('🌐 验证出口 IP...');
        try {
            const ipPage = await browser.newPage();
            const res = await ipPage.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 10000 });
            const body = await res.text();
            const ip = JSON.parse(body).ip || body;
            const masked = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
            console.log(`✅ 出口 IP 确认：${masked}`);
            await ipPage.close();
        } catch {
            console.log('⚠️ IP 验证超时，跳过');
        }

        let allSummary = [];
        let globalHasError = false;

        // ── 遍历处理每个 Token 账号 ─────────────────────────
        for (let tIndex = 0; tIndex < tokens.length; tIndex++) {
            let currentToken = tokens[tIndex];
            let customName = null;

            // 支持 '自定义备注#Token' 或 '自定义备注:Token' 的格式
            const match = currentToken.match(/^([^#:]+)[#:](.+)$/);
            if (match) {
                customName = match[1].trim();
                currentToken = match[2].trim();
            }

            let accountLabel = customName ? `👤 ${customName}` : `👤 账号 ${tIndex + 1}`;
            
            console.log('\n' + '='.repeat(50));
            console.log(`🚀 开始处理 ${accountLabel}`);
            console.log('='.repeat(50));

            // 每个账号使用独立的上下文，隔离 Cookie 和 LocalStorage
            const context = await browser.newContext();
            const page = await context.newPage();
            page.setDefaultTimeout(TIMEOUT);
            
            try {
                // ── 预登录 Discord ────────────────────────────────────
                console.log('🔑 使用 Token 预登录 Discord...');
                await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
                
                await page.evaluate((token) => {
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
                }, currentToken);
                
                console.log('🔄 刷新页面验证 Token...');
                await page.waitForTimeout(1000);
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(3000);
                
                if (page.url().includes('login')) {
                    throw new Error('Discord Token 失效或被踢出，登录失败');
                }
                console.log('✅ Discord Token 验证有效...');

                // ── 尝试自动读取 Discord 账号名 ─────────────────────
                try {
                    const autoName = await page.evaluate(async (tok) => {
                        try {
                            const res = await fetch('https://discord.com/api/v9/users/@me', {
                                headers: { 'Authorization': tok }
                            });
                            if (!res.ok) return null;
                            const data = await res.json();
                            return data.global_name || data.username || data.email || null;
                        } catch(err) { return null; }
                    }, currentToken);
                    
                    if (autoName) {
                        console.log(`🤖 成功抓取 Discord 档案: ${autoName}`);
                        if (!customName) {
                            accountLabel = `👤 ${autoName}`;
                        }
                    }
                } catch (e) { }

                // ── 登录 FreezeHost ───────────────────────────────────
                console.log('🔑 打开 FreezeHost 登录页...');
                await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });

                console.log('📤 点击 Login with Discord...');
                await page.click('span.text-lg:has-text("Login with Discord")');

                console.log('⏳ 检测并关闭 Cookie 同意弹窗...');
                try {
                    // FundingChoices / Google CMP 弹窗
                    const cookieAcceptSelectors = [
                        'button.fc-cta-consent',
                        'button.fc-button-label',
                        '[aria-label="Consent"]',
                        'button:has-text("同意")',
                        'button:has-text("Accept")',
                        'button:has-text("Agree")',
                        'button:has-text("OK")',
                    ];
                    for (const sel of cookieAcceptSelectors) {
                        const btn = page.locator(sel).first();
                        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                            await btn.click({ force: true });
                            console.log(`  ✅ 已关闭 Cookie 弹窗 (${sel})`);
                            await page.waitForTimeout(500);
                            break;
                        }
                    }
                } catch { /* 没有弹窗或已关闭，继续 */ }

                console.log('⏳ 等待服务条款弹窗...');
                const confirmBtn = page.locator('button#confirm-login');
                await confirmBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
                if (await confirmBtn.isVisible()) {
                    await confirmBtn.click({ force: true });
                    console.log('✅ 已接受服务条款');
                }

                // ── OAuth 授权 ────────────────────────────────────────
                console.log('⏳ 等待 OAuth 授权...');
                try {
                    await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
                    console.log('🔍 进入 OAuth 授权页，处理中...');
                    await page.waitForTimeout(2000);
                    
                    if (page.url().includes('discord.com')) {
                        await handleOAuthPage(page);
                    } else {
                        console.log('✅ 已自动完成授权，无需手动点击');
                    }
                    
                    await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
                    console.log(`✅ 已离开 Discord，当前：${page.url()}`);
                } catch {
                    console.log(`✅ 静默授权或已跳转，当前：${page.url()}`);
                }

                // ── 确认到达 Dashboard ────────────────────────────────
                console.log('⏳ 确认到达 Dashboard...');
                try {
                    await page.waitForURL(
                        url => url.includes('/callback') || url.includes('/dashboard'),
                        { timeout: 10000 }
                    );
                } catch { /* 可能已经在 dashboard */ }

                if (page.url().includes('/callback')) {
                    await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
                }

                if (!page.url().includes('/dashboard')) {
                    throw new Error(`未到达 Dashboard，当前 URL: ${page.url()}`);
                }
                console.log(`✅ 登录成功！当前：${page.url()}`);
                await page.waitForTimeout(3000);

                // ── 提取金币余额 ──────────────────────────────────────
                console.log('🔍 提取当前金币余额...');
                let coins = '未知';
                try {
                    const coinText = await page.evaluate(() => {
                        // 1. 尝试精确定位 "AVAILABLE BALANCE"
                        const allEls = Array.from(document.querySelectorAll('*'));
                        const balEl = allEls.find(e => e.children.length === 0 && e.textContent.includes('AVAILABLE BALANCE'));
                        if (balEl) {
                            let p = balEl.parentElement;
                            while(p && p.innerText.length < 200) {
                                if (/\d/.test(p.innerText)) return p.innerText;
                                p = p.parentElement;
                            }
                        }
                        // 2. 尝试找 .fa-coins
                        const coinIcon = document.querySelector('.fa-coins');
                        if (coinIcon && coinIcon.parentElement) return coinIcon.parentElement.innerText.trim();
                        // 3. Fallback: 找含有 Coins 的短文本
                        const elements = Array.from(document.querySelectorAll('span, div, p, h1, h2, h3, h4, h5, h6, b, strong'));
                        for (const el of elements) {
                            if (el.innerText && el.innerText.includes('Coins') && el.innerText.length < 20) return el.innerText.trim();
                        }
                        return '未知';
                    });
                    
                    const matches = coinText.match(/[\d,]+(\.\d+)?/g);
                    if (matches) {
                        // 取出最长的一串数字（如 2,078）
                        coins = matches.reduce((longest, current) => current.length > longest.length ? current : longest, matches[0]);
                    }
                    console.log(`💰 当前金币: ${coins}`);
                } catch (e) {
                    console.log('⚠️ 获取金币失败');
                }
                
                const prefix = tIndex === 0 ? '' : '\n';
                allSummary.push(`${prefix}${accountLabel} | 💰 ${coins}`);

                // ── 查找所有 Server Console 链接 ───────────────────────
                console.log('🔍 查找所有 Server 的 Manage 按钮...');
                const serverUrls = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a[href*="server-console"]'));
                    return links.map(link => link.href);
                });

                if (serverUrls.length === 0) {
                    allSummary.push(`  ❌ 获取服务器列表失败或为空\n`);
                    console.log('⚠️ 未找到任何服务器');
                    continue; 
                }

                console.log(`✅ 共找到 ${serverUrls.length} 个服务器`);

                // ── 遍历处理该账号下的每个 Server ─────────────────────
                for (let i = 0; i < serverUrls.length; i++) {
                    const sUrl = serverUrls[i];
                    console.log(`\n▶️ 开始处理第 ${i + 1}/${serverUrls.length} 个服务器`);
                    console.log(`  🔗 ${sUrl}`);
                    await page.goto(sUrl, { waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(3000);
                    
                    // 1. 尝试抓取具体的服务器名字
                    const serverName = await page.evaluate(() => {
                        const h = document.querySelector('h1, h2, h3, .server-name, .font-bold.text-xl');
                        if (h && h.innerText && h.innerText.length < 30) return h.innerText.trim();
                        let title = document.title;
                        title = title.replace(/ - .+$/, '').replace(/Dashboard/i, '').trim();
                        return title || `Node ${i+1}`;
                    });
                    console.log(`  📛 服务器名称: ${serverName}`);

                    // 2. 抓取续期状态文本
                    const renewalStatusText = await page.evaluate(() => {
                        const el = document.getElementById('renewal-status-console');
                        return el ? el.innerText.trim() : null;
                    });
                    console.log(`  📋 续期状态原文：${renewalStatusText}`);

                    let shouldRenew = true;
                    let timeDisplay = '未知时效';

                    if (renewalStatusText) {
                        let d = 0, h = 0, m = 0;
                        let parsed = false;
                        let remainingDaysVal = -1;

                        const dMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*day/i);
                        const hMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*hour/i);
                        const mMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*minute/i);

                        if (dMatch || hMatch || mMatch) {
                            const valD = dMatch ? parseFloat(dMatch[1]) : 0;
                            const valH = hMatch ? parseFloat(hMatch[1]) : 0;
                            const valM = mMatch ? parseFloat(mMatch[1]) : 0;

                            // 统一折算为总天数
                            remainingDaysVal = valD + (valH / 24) + (valM / 1440);

                            // 再重新干净地分解为天、时、分
                            d = Math.floor(remainingDaysVal);
                            const tH = (remainingDaysVal - d) * 24;
                            h = Math.floor(tH);
                            m = Math.round((tH - h) * 60);
                            parsed = true;
                        }

                        if (parsed) {
                            timeDisplay = `${d}天 ${h}小时 ${m}分钟`;
                            console.log(`  ⏳ 精确时效计算：${timeDisplay}`);
                            
                            if (remainingDaysVal > 7) {
                                console.log(`  🛡️ 剩余 > 7 天，无需续期`);
                                shouldRenew = false;
                            } else {
                                console.log(`  ✅ 剩余 <= 7 天，符合条件，准备点击...`);
                            }
                        }
                    }

                    // 准备推送排版
                    let statusText = '';
                    let finalTimeDisplay = timeDisplay;

                    const pushResult = () => {
                        allSummary.push(`  📦 ${serverName}`);
                        allSummary.push(`  ├─ 状态: ${statusText}`);
                        allSummary.push(`  └─ 剩余: ${finalTimeDisplay}\n`);
                    };

                    if (!shouldRenew) {
                        statusText = `无需续期`;
                        pushResult();
                        continue;
                    }

                    // ── 点击外链图标打开续期弹窗 ─────────────────────────
                    console.log('  🔍 查找续期入口...');
                    try {
                        // 只匹配可见的外链图标，跳过隐藏的 reviewAction 等按钮
                        const externalLinkIcon = page.locator('i.fa-external-link-alt:visible').first();
                        const parentEl = externalLinkIcon.locator('xpath=..');
                        await parentEl.waitFor({ state: 'visible', timeout: 8000 });
                        await parentEl.hover();
                        await page.waitForTimeout(1000);
                        await externalLinkIcon.click({ force: true });
                        await page.waitForTimeout(2000);

                        const renewModalBtn = page.locator('#renew-link-modal');
                        await renewModalBtn.waitFor({ state: 'visible', timeout: 5000 });
                        const btnText = (await renewModalBtn.innerText()).trim();

                        if (!btnText.toLowerCase().includes('renew instance')) {
                            statusText = `⏰ 未到续期条件`;
                            console.log('  ⏰ 尚未到续期时间，跳过');
                            pushResult();
                            continue;
                        }

                        const renewHref = await renewModalBtn.getAttribute('href');
                        if (!renewHref || renewHref === '#') throw new Error('无效的续期链接');

                        const renewAbsUrl = new URL(renewHref, page.url()).href;
                        console.log(`  📤 跳转 RENEW 链接...`);
                        await page.goto(renewAbsUrl, { waitUntil: 'domcontentloaded' });
                        await page.waitForURL(url => url.toString().includes('/dashboard') || url.toString().includes('/server-console'), { timeout: 30000 });
                        
                        const finalUrl = page.url();
                        if (finalUrl.includes('success=RENEWED')) {
                            console.log('  🎉 续期成功！');
                            statusText = `✅ 续期成功`;
                            finalTimeDisplay = `14天 0小时 0分钟`; // 成功基本就是满血14天
                        } else if (finalUrl.includes('err=CANNOTAFFORDRENEWAL')) {
                            console.log('  ⚠️ 余额不足，无法续期');
                            statusText = `⚠️ 余额不足`;
                        } else if (finalUrl.includes('err=TOOEARLY')) {
                            console.log('  ⏰ 尚未到续期时间');
                            statusText = `⏰ 未到续期限制`;
                        } else {
                            console.log(`  ⚠️ 续期结果未知：${finalUrl}`);
                            statusText = `❓ 结果未知`;
                        }
                    } catch (err) {
                        console.log(`  ❌ 处理此服务器时发生错误: ${err.message}`);
                        statusText = `❌ 异常 (${err.message.slice(0, 15)})`;
                        globalHasError = true;
                    }
                    pushResult();
                } // End Server Loop
            } catch (err) {
                console.log(`❌ 账号 ${tIndex + 1} 发生异常: ${err.message}`);
                allSummary.push(`${accountLabel} ❌ 登录或处理失败 (${err.message.slice(0, 30)})`);
                globalHasError = true;
            } finally {
                await context.close();
            }
        } // End Token Loop

        // ── 发送总体通知（仅在最后一次尝试时推送，避免重试重复通知） ──
        console.log('\n📄 最终执行报告:');
        const finalPushText = allSummary.join('\n');
        console.log(finalPushText);

        const isLastAttempt = testInfo.retry >= testInfo.project.retries;
        if (!globalHasError || isLastAttempt) {
            await sendTG(finalPushText);
        } else {
            console.log(`⏭️ 检测到错误且非最后一次尝试 (Retry ${testInfo.retry}/${testInfo.project.retries})，跳过 TG 推送`);
        }

        if (globalHasError) {
            throw new Error('部分账号或服务器续期过程中发生错误，请查看日志');
        }

    } catch (e) {
        if (!e.message?.includes('由于部分服务器') && !e.message?.includes('部分账号或服务器')) {
            await sendTG(`❌ 脚本全局异常：${e.message}`);
        }
        throw e;

    } finally {
        await browser.close();
    }
});
