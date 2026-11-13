/**
 * The seller agreement suppliers download, sign and upload during onboarding.
 * Kept in code (not on disk) so it ships with the API on serverless hosts.
 * Served as a printable HTML page; the store name is filled in per request.
 */
export const SELLER_AGREEMENT_FILE_NAME = 'seller-agreement.html';
export const SELLER_AGREEMENT_VERSION = '2026-11';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function sellerAgreementHtml(storeName: string): string {
  const store = esc(storeName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${store} Seller Agreement</title>
<style>
  body { font: 15px/1.6 Georgia, "Times New Roman", serif; color: #1b1b1b; max-width: 760px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 28px; }
  .muted { color: #555; font-size: 13px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 40px; }
  .line { border-bottom: 1px solid #000; height: 36px; }
  @media print { body { margin: 0 auto; } }
</style>
</head>
<body>
<h1>${store} Seller Agreement</h1>
<p class="muted">Version ${SELLER_AGREEMENT_VERSION}. Print this page, sign it and upload the signed copy (PDF, JPG or PNG) in the Seller Portal.</p>

<p>This agreement is between ${store} (“we”, “us”) and the business named below (“Supplier”, “you”). It applies to every product you list and every order you fulfil through our marketplace.</p>

<h2>1. Listing products</h2>
<p>You may list products only in the categories we approved for you. Every product and every change to a product is reviewed by our catalog team before customers see it. Product information must be accurate, complete and not misleading, and you must hold the rights to the images and text you provide.</p>

<h2>2. Shipping and fulfilment</h2>
<p>You ship from a warehouse in the United States to all 50 states, within the handling time you told us. You provide tracking for every parcel and keep your stock levels up to date so customers can’t order items you don’t have.</p>

<h2>3. Pricing and payment</h2>
<p>You set the wholesale price for each product. We set the retail price and collect payment from customers. We pay you the wholesale price for each delivered order, less any refunds, on the schedule shown in the Seller Portal. Once approved, we provide our resale certificate (Form E-595E) so you don’t charge us sales tax.</p>

<h2>4. Returns and quality</h2>
<p>You accept returns under our customer returns policy. Products must be new, safe, compliant with applicable law and free of defects. We may take products off sale while we look into a quality, safety or compliance concern.</p>

<h2>5. Documents and insurance</h2>
<p>You keep a current W-9 and a certificate of general liability insurance on file with us. You upload a new certificate before the current one expires.</p>

<h2>6. Suspension and termination</h2>
<p>We may suspend your account, hiding your products and stopping new orders, if you breach this agreement, your insurance lapses, or you repeatedly ship late. We tell you why and how to be reinstated. Either party may end this agreement with 30 days’ written notice; orders placed before then are still fulfilled.</p>

<h2>7. General</h2>
<p>You are an independent business; nothing here creates a partnership or employment. This agreement is governed by the laws of the state where ${store} is registered.</p>

<div class="sign">
  <div><div class="line"></div><p class="muted">Supplier legal business name</p></div>
  <div><div class="line"></div><p class="muted">EIN</p></div>
  <div><div class="line"></div><p class="muted">Authorised signatory (name and title)</p></div>
  <div><div class="line"></div><p class="muted">Signature and date</p></div>
</div>
</body>
</html>
`;
}
