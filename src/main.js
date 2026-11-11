import './style.css';
import './wordmark.css';
import './footer.css';
import './hero-media.css';
import './responsive.css';
import './account.css';
import { renderAccountPage, mountAccountPage, mountAccountLinks } from './account.js';
import heroLogoUrl from './assets/brand/silkiiittt.png?url';
import whatsappUrl from './assets/icons/whatsapp.svg?url';
import whatsappFooterUrl from './assets/icons/whatsappf.svg?url';
import tiktokUrl from './assets/icons/tiktok.svg?url';
import { getProductMedia } from './product-media.js';
import { productCatalog } from './product-catalog.js';
import { cart } from './cart.js';
import { mountCheckout } from './checkout.js';
import cartModalMarkup from './cart-modal.html?raw';

const wordmarkMarkup = `
  <span class="wordmark__top"><span class="wordmark__silk">Silk</span> <span class="wordmark__it">It</span></span>
  <span class="wordmark__elegantly">Elegantly</span>
`;

const products = [
  {
    id: 'mauve-mist',
    name: 'Mauve Mist',
    detail: 'Everyday / Rose silk',
    price: 'From €85',
    className: 'product-mauve',
    images: ['/source-assets/collection/1.jpg'],
    description: 'A soft, breathable rose-toned silk designed for effortless elegance throughout the day.',
    priceOptions: productCatalog['mauve-mist'].priceOptions
  },
  {
    id: 'ivory-whisper',
    name: 'Ivory Whisper',
    detail: 'Occasion / Pearl silk',
    price: 'From €95',
    className: 'product-ivory',
    images: ['/source-assets/collection/IMG_2726.jpg', '/source-assets/collection/IMG_2728.jpg'],
    description: 'A luminous pearl silk with a subtle glow, crafted for unforgettable entrances and special memories.',
    priceOptions: productCatalog['ivory-whisper'].priceOptions
  },
  {
    id: 'midnight-fig',
    name: 'Midnight Fig',
    detail: 'Signature / Plum silk',
    price: 'From €110',
    className: 'product-fig',
    images: ['/source-assets/collection/IMG_2730.jpg'],
    description: 'A deep, rich plum silk that makes a bold yet quiet statement. The pinnacle of our signature collection.',
    priceOptions: productCatalog['midnight-fig'].priceOptions
  },
  {
    id: 'rose-dawn',
    name: 'Rose Dawn',
    detail: 'Everyday / Soft Rose',
    price: 'From €85',
    className: 'product-mauve',
    images: ['/source-assets/collection/IMG_2721.jpg', '/source-assets/collection/IMG_2722.jpg'],
    description: 'A gentle start to the day with soft rose hues.',
    priceOptions: productCatalog['rose-dawn'].priceOptions
  },
  {
    id: 'pearl-essence',
    name: 'Pearl Essence',
    detail: 'Occasion / Luminous Pearl',
    price: 'From €95',
    className: 'product-ivory',
    images: ['/source-assets/collection/4.jpg'],
    description: 'Luminous and pure, perfect for special moments.',
    priceOptions: productCatalog['pearl-essence'].priceOptions
  },
  {
    id: 'deep-plum',
    name: 'Deep Plum',
    detail: 'Signature / Velvet Plum',
    price: 'From €110',
    className: 'product-fig',
    images: ['/source-assets/collection/3.jpg'],
    description: 'A bold statement of confidence and grace.',
    priceOptions: productCatalog['deep-plum'].priceOptions
  },
  {
    id: 'blush-silk',
    name: 'Blush Silk',
    detail: 'Everyday / Blush',
    price: 'From €85',
    className: 'product-mauve',
    images: ['/source-assets/collection/IMG_2724.jpg', '/source-assets/collection/IMG_2725.jpg'],
    description: 'Softly colored silk for a subtle, feminine touch.',
    priceOptions: productCatalog['blush-silk'].priceOptions
  },
  {
    id: 'moonlit-ivory',
    name: 'Moonlit Ivory',
    detail: 'Occasion / Ivory Glow',
    price: 'From €95',
    className: 'product-ivory',
    images: ['/source-assets/collection/IMG_2723.jpg'],
    description: 'Glowing ivory silk that captures the moonlight.',
    priceOptions: productCatalog['moonlit-ivory'].priceOptions
  },
  {
    id: 'royal-fig',
    name: 'Royal Fig',
    detail: 'Signature / Royal Plum',
    price: 'From €110',
    className: 'product-fig',
    images: ['/source-assets/collection/5.jpg'],
    description: 'The depth of plum combined with royal elegance.',
    priceOptions: productCatalog['royal-fig'].priceOptions
  }
];

// Product folders are the primary gallery source; original photos remain a fallback.
products.forEach((product) => {
  const folderMedia = getProductMedia(product.id);
  product.media = folderMedia.length ? folderMedia : product.images.map(url => ({ type: 'image', url }));
  const folderImages = product.media.filter(media => media.type === 'image').map(media => media.url);
  if (folderImages.length) product.images = folderImages;
});

const icon = (name) => ({
  arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>`,
  snapchat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c-3.2 0-4.6 2.6-4.4 5.8l.1 1.3c-.7.1-1.4-.5-2-.2-.6.3-.4 1 .2 1.3l1.8.8c-.4 1.7-1.6 3.1-3.5 3.7-.4.2-.3.6.2.8l2.1.6.5 1.5 2.5-.3c.8.6 1.6.9 2.5.9s1.7-.3 2.5-.9l2.5.3.5-1.5 2.1-.6c.5-.2.6-.6.2-.8-1.9-.6-3.1-2-3.5-3.7l1.8-.8c.6-.3.8-1 .2-1.3-.6-.3-1.3.3-2 .2l.1-1.3C16.6 5.6 15.2 3 12 3Z"/></svg>`,
  whatsapp: `<img src="${whatsappUrl}" alt="WhatsApp" style="width:16px; height:16px; object-fit:contain;">`,
  whatsappf: `<img src="${whatsappFooterUrl}" alt="WhatsApp" style="width:18px; height:18px; object-fit:contain;">`,
  tiktok: `<img src="${tiktokUrl}" alt="TikTok" style="width:18px; height:18px; object-fit:contain;">`
})[name];

const productMarkup = products.map((item, i) => `
  <article class="product-card" data-product="${item.detail.split(' ')[0].toLowerCase()}">
    <a href="#product/${item.id}" class="product-visual-link">
      <div class="product-visual ${item.className}"><img class="product-photo" src="${item.images[0]}" alt="${item.name} silk malehfa" loading="lazy" /><span class="product-label">0${i + 1}</span><span class="fabric-fold fold-a"></span><span class="fabric-fold fold-b"></span></div>
    </a>
    <div class="product-info"><div><h3>${item.name}</h3><p>${item.detail}</p></div><strong>${item.price}</strong></div>
    <a href="#product/${item.id}" class="product-link">View details ${icon('arrow')}</a>
    <button class="add-to-cart-btn" data-product-id="${item.id}">Add to Cart</button>
  </article>`).join('');

const renderShell = (content = '') => {
  return `
    <header class="site-header">
      <a href="#top" class="wordmark">
        ${wordmarkMarkup}
      </a>
      <nav class="desktop-nav">
        <a href="#collection">Collection</a>
        <a href="#atelier">Atelier</a>
        <a href="#process">Process</a>
        <a href="#journal">Journal</a>
      </nav>
      <div class="header-actions">
        <a href="https://wa.me/33768353638" class="mini-whatsapp" target="_blank" rel="noreferrer">
          Talk to us ${icon('whatsapp')}
        </a>
        <button class="header-cart-icon" aria-label="View cart">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 8h11.6a1 1 0 0 1 1 1.1l-.6 9.4a1.6 1.6 0 0 1-1.6 1.5H7.4a1.6 1.6 0 0 1-1.6-1.5L5.2 9.1a1 1 0 0 1 1-1.1Z"/><path d="M9 9V7.2a3 3 0 0 1 6 0V9"/></svg>
          <span class="cart-count" aria-label="Items in cart">0</span>
        </button>
        <a href="#signin" class="header-account-link" data-account-link>Sign in | up</a>
        <button class="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-navigation">
          ${icon('menu')}
        </button>
      </div>
    </header>
    <div class="marquee">
      <div>
        <span class="marquee-text">Wear your story.</span>
        <span class="marquee-star">★</span>
        <span class="marquee-text">Softness with a point of view.</span>
        <span class="marquee-star">★</span>
        <span class="marquee-text">Wear your story.</span>
        <span class="marquee-star">★</span>
        <span class="marquee-text">Softness with a point of view.</span>
        <span class="marquee-star">★</span>
      </div>
    </div>
    <nav id="mobile-navigation" class="mobile-nav" aria-label="Mobile navigation" aria-hidden="true" inert>
      <button class="mobile-close" aria-label="Close menu">${icon('close')}</button>
      <a href="#collection">Collection</a>
      <a href="#atelier">Atelier</a>
      <a href="#process">Process</a>
      <a href="#journal">Journal</a>
      <a href="#signin" data-account-link>Sign in | up</a>
      <a href="#signup">Create account</a>
      <a href="https://wa.me/33768353638" class="button button-dark" target="_blank" rel="noreferrer">Talk to us ${icon('whatsapp')}</a>
    </nav>
    <main id="main-content">${content}</main>
    <footer class="site-footer">
      <div class="footer-top">
        <div class="footer-brand">
          <div class="wordmark footer-mark">${wordmarkMarkup}</div>
          <p class="footer-tagline">Personalized silk malehfas &amp; scarfs<br />for your every kind of elegance</p>
          <div class="socials">
            <a href="https://www.instagram.com/silkitelegantly/" target="_blank" rel="noreferrer" aria-label="Instagram">${icon('instagram')}</a>
            <a href="https://www.tiktok.com/@silkit.elegantly" target="_blank" rel="noreferrer" aria-label="TikTok">${icon('tiktok')}</a>
            <a href="https://www.snapchat.com/@silkitelegantly" target="_blank" rel="noreferrer" aria-label="Snapchat">${icon('snapchat')}</a>
            <a href="https://wa.me/33768353638" target="_blank" rel="noreferrer" aria-label="WhatsApp">${icon('whatsappf')}</a>
          </div>
        </div>
      </div>
      <div class="footer-bottom">
        <div class="footer-links">
          <a href="#top">Top</a>
          <a href="#collection">Collection</a>
          <a href="#atelier">Atelier</a>
          <a href="#account" data-account-link>Sign in | up</a>
          <a href="#privacy">Privacy</a>
        </div>
        <div class="footer-copy">
          <span class="footer-intention">Made with softness & intention</span>
          <br />
          <span>&copy; 2026 SilkItElegantly</span>
        </div>
      </div>
    </footer>
    ${cartModalMarkup}
  `;
};

const renderHome = () => {
  return `
    <section class="hero section-pad">
      <div class="hero-copy"><span class="eyebrow fade-in">The art of being covered elegantly</span><h1 class="fade-in delay-1"><span class="hero-title-line">Your silky malehfa.</span><br /><i>Your signature.</i></h1><p class="hero-lede fade-in delay-2">Personalized malehfas, made to move with you</p><div class="hero-buttons fade-in delay-3"><a class="button button-dark" href="#collection">Explore the collection ${icon('arrow')}</a><a class="button button-ghost" href="https://wa.me/33768353638" target="_blank" rel="noreferrer">Talk to us on WhatsApp ${icon('whatsapp')}</a></div><div class="hero-note"><span class="note-line"></span><span>Hand-finished in small quantities<br />for the women who notice every detail.</span></div></div>
      <div class="hero-logo"><img class="hero-brand-image" src="${heroLogoUrl}" width="500" height="500" alt="Silk It Elegantly illustrated brand logo" fetchpriority="high" /></div>
      <div class="scroll-cue"><span>Scroll to discover</span><i></i></div>
    </section>
    <section class="section-pad collection-section" id="collection"><div class="section-heading compact"><div><span class="eyebrow">The edit / 01</span><h2>Pieces to live in.</h2></div><a class="text-link" href="#collection">View all pieces ${icon('arrow')}</a></div><div class="product-grid">${productMarkup}</div></section>
    <section class="story-section" id="atelier"><div class="story-visual"><div class="story-stamp">S<br />E</div><div class="story-fabric"></div><div class="story-caption">The silk<br /><i>is the story.</i></div></div><div class="story-copy"><span class="eyebrow">Inside the atelier</span><h2>A little luxury,<br /><i>made personal.</i></h2><p>We believe the most beautiful things are the ones that feel like they already belong to you. Every SilkItElegantly malehfa is made from luminous silk, selected for its touch, drape, and quiet confidence.</p><p>From the first color story to the final finishing detail, we make room for your point of view.</p><a class="button button-dark" href="#process">Meet your malehfa ${icon('arrow')}</a><div class="story-signature">silk with elegance</div></div></section>
    <section class="section-pad process-section" id="process"><div class="section-heading"><div><span class="eyebrow">The personal edit</span><h2>From your mood<br /><i>to your malehfa.</i></h2></div><p>Thoughtfully simple. Completely yours. We make personalization feel like a friendly conversation.</p></div><div class="process-grid"><div class="process-step"><span>01</span><h3>Choose your design</h3><p>Start with a color, a texture, or simply a feeling. We will guide you toward the right silk story.</p></div><div class="process-step"><span>02</span><h3>Make it yours</h3><p>Share the details that matter: your dimensions, your finish, your little signature.</p></div><div class="process-step"><span>03</span><h3>Wear it beautifully</h3><p>Your malehfa is finished with care, packed and sent to you, ready for its first story.</p></div></div><div class="process-cta"><span>Need a little help choosing?</span><a href="https://wa.me/33768353638">Book a personal edit ${icon('arrow')}</a></div></section>
    <section class="quote-section" id="journal"><div class="quote-mark">“</div><blockquote>It feels like wearing a piece of art that was made with my name in mind.</blockquote><cite>— Sarah M. / The Signature edit</cite><div class="quote-dots"><span class="active"></span><span></span><span></span></div></section>
    <section class="newsletter-section section-pad"><div class="newsletter-card"><div><span class="eyebrow">A note from the atelier</span><h2>Come a little<br /><i>closer.</i></h2><p>New silk stories, styling notes, and first access to our next edit. Delivered softly, never loudly.</p></div><div class="signup-form"><p>Create your private SilkItElegantly account. Atelier notes are optional when you sign up.</p><a class="button button-dark" href="#signup">Create your account ${icon('arrow')}</a><small class="form-message">Already registered? <a href="#signin">Sign in</a>.</small></div></div></section>
  `;
};

const renderProduct = (id) => {
  const product = products.find(p => p.id === id);
  if (!product) return renderHome();
  const bgClass = product.className.replace('product-', 'img-');
  return `
    <div class="product-detail-grid fade-in">
      <div class="product-gallery">
        ${product.media.map((media, index) => media.type === 'video'
          ? `<video class="product-video" controls playsinline preload="metadata" aria-label="${product.name} product video ${index + 1}"><source src="${media.url}" type="${media.mime}" />Your browser does not support this video. <a href="${media.url}">Download the product video</a>.</video>`
          : `<img src="${media.url}" class="${bgClass}" alt="${product.name} silk detail ${index + 1}" loading="${index === 0 ? 'eager' : 'lazy'}" />`
        ).join('')}
      </div>
      <div class="product-info-panel">
        <a href="#collection" class="back-link">← Back to collection</a>
        <span class="detail-meta">${product.detail}</span>
        <h1>${product.name}</h1>
        <div class="price">${product.price}</div>
        <div class="product-options-group" data-product-id="${product.id}">
          <label for="size-${product.id}" class="option-label">Choose option</label>
          <select id="size-${product.id}" name="size" data-name="size">
            ${product.priceOptions?.map(opt => `<option value="${opt.option}" data-price="${opt.price}">${opt.option} - ${formatDisplayPrice(opt.price)}</option>`).join('')}
          </select>
          <button class="add-to-cart-btn" data-product-id="${product.id}">Add to Cart</button>
        </div>
        <p class="description">${product.description}</p>
        <a href="https://wa.me/33768353638?text=I%27m%20interested%20in%20the%20${encodeURIComponent(product.name)}" target="_blank" rel="noreferrer" class="order-whatsapp-btn">
          Order via WhatsApp ${icon('arrow')}
        </a>
      </div>
    </div>
  `;
};

const renderCollection = () => {
  return `
    <div class="collection-page fade-in">
      <div class="collection-header">
        <a href="#top" class="back-link">← Back to home</a>
        <div class="collection-title">
          <span class="eyebrow">The Edit / 01</span>
          <h1>Pieces to live in.</h1>
          <p>A curated selection of our finest silk malehfas, designed for every mood and every moment.</p>
        </div>
      </div>
      ${products.map((item, i) => `
        <article class="product-card" data-product="${item.detail.split(' ')[0].toLowerCase()}">
          <a href="#product/${item.id}" class="product-visual-link">
            <div class="product-visual ${item.className}"><img class="product-photo" src="${item.images[0]}" alt="${item.name} silk malehfa" loading="lazy" /><span class="product-label">0${i + 1}</span><span class="fabric-fold fold-a"></span><span class="fabric-fold fold-b"></span></div>
          </a>
          <div class="product-info"><div><h3>${item.name}</h3><p>${item.detail}</p></div><strong>${item.price}</strong></div>
          <a href="#product/${item.id}" class="product-link">View details ${icon('arrow')}</a>
          <div class="product-options-group" data-product-id="${item.id}">
            <label for="collection-size-${item.id}" class="option-label">Choose option</label>
            <select id="collection-size-${item.id}" name="size" data-name="size">
              ${item.priceOptions?.map(opt => `<option value="${opt.option}" data-price="${opt.price}">${opt.option} - ${formatDisplayPrice(opt.price)}</option>`).join('')}
            </select>
            <button class="add-to-cart-btn" data-product-id="${item.id}">Add to Cart</button>
          </div>
        </article>
      `).join('')}
    </div>
  `;
};

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(amount);
}

function formatDisplayPrice(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(amount);
}

function updateCartCount() {
  const count = cart.getCount();
  document.querySelectorAll('.cart-count').forEach((el) => {
    el.textContent = count;
    el.hidden = count === 0;
  });
  const totalEl = document.querySelector('.footer-total');
  if (totalEl) {
    totalEl.textContent = formatCurrency(cart.getTotal());
  }
}

function renderCartItems() {
  const container = document.querySelector('.cart-items');
  if (!container) return;

  const items = cart.getItems();
  if (!items.length) {
    container.innerHTML = '<p class="cart-empty">Your cart is empty.<br />Add a piece to begin your silk story.</p>';
    return;
  }

  container.innerHTML = items.map((item) => `
    <div class="cart-item" data-key="${item.key}">
      <div class="cart-item-info">
        <h3>${item.productName}</h3>
        <p class="cart-item-details">${item.option}</p>
      </div>
      <div class="cart-item-qty">
        <button type="button" data-cart-action="decrease" aria-label="Decrease quantity">&minus;</button>
        <span>${item.quantity}</span>
        <button type="button" data-cart-action="increase" aria-label="Increase quantity">+</button>
      </div>
      <strong class="cart-item-price">${formatCurrency(item.price * item.quantity)}</strong>
      <button type="button" class="cart-item-remove" data-cart-action="remove" aria-label="Remove item">&times;</button>
    </div>
  `).join('');
}

function showToast(message) {
  const toast = document.getElementById('cart-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function openCart() {
  const modal = document.getElementById('cart-modal');
  if (!modal) return;
  resetCheckout();
  renderCartItems();
  updateCartCount();
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('cart-open');
}

function closeCart() {
  const modal = document.getElementById('cart-modal');
  if (!modal) return;
  resetCheckout();
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('cart-open');
}

function resolveSelection(button) {
  const product = products.find((p) => p.id === button.dataset.productId);
  if (!product) return null;

  const group = button.closest('.product-options-group');
  let option = null;

  const select = group?.querySelector('select');
  if (select?.value) {
    option = select.value;
  } else {
    const radio = document.querySelector(`input[name="${product.id}_option"]:checked`);
    if (radio) option = radio.value;
  }

  const match = option ? product.priceOptions?.find((entry) => entry.option === option) : null;
  const fallback = product.priceOptions?.[0];

  return {
    product,
    option: match?.option || fallback?.option || 'Default',
    price: match?.price ?? fallback?.price ?? 0,
  };
}

function setupEventListeners() {
  document.querySelectorAll('.add-to-cart-btn').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const selection = resolveSelection(button);
      if (!selection) return;

      cart.addItem({
        productId: selection.product.id,
        productName: selection.product.name,
        option: selection.option,
        price: selection.price,
        image: selection.product.images?.[0],
      });

      updateCartCount();
      renderCartItems();
      showToast(`${selection.product.name} added to cart`);
    });
  });
}

function handleRoute() {
  const hash = window.location.hash;
  const routeMode = hash.replace(/^#/, '').split('?')[0];
  const accountRoute = ['signup', 'signin', 'verify-email', 'forgot-password', 'reset-password', 'account', 'privacy'].includes(routeMode);
  const app = document.getElementById('app');
  if (!app) return;

  let content;
  if (accountRoute) {
    content = renderAccountPage(routeMode);
  } else if (hash.startsWith('#product/')) {
    const id = hash.split('/')[1];
    content = renderProduct(id);
  } else if (hash === '#collection') {
    content = renderCollection();
  } else {
    content = renderHome();
  }
  resetCheckout();
  document.body.classList.remove('cart-open', 'menu-open');
  app.innerHTML = renderShell(content);
  renderCartItems();
  updateCartCount();
  setupEventListeners();
  if (accountRoute) void mountAccountPage();
  void mountAccountLinks();
  requestAnimationFrame(() => {
    const sectionId = hash.replace(/^#/, '');
    const section = ['atelier', 'process', 'journal'].includes(sectionId) ? document.getElementById(sectionId) : null;
    if (section) section.scrollIntoView({ behavior: 'instant', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
  });
}

const resetCheckout = mountCheckout({ cart, formatCurrency, showToast, updateCartCount, renderCartItems });

window.addEventListener('hashchange', handleRoute);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', handleRoute);
} else {
  handleRoute();
}

const setMenu = (open) => {
  const mobileNav = document.querySelector('.mobile-nav');
  if (!mobileNav) return;
  mobileNav.classList.toggle('open', open);
  mobileNav.inert = !open;
  document.body.classList.toggle('menu-open', open);
  mobileNav.setAttribute('aria-hidden', String(!open));
  const toggle = document.querySelector('.menu-toggle');
  toggle?.setAttribute('aria-expanded', String(open));
  if (open) mobileNav.querySelector('.mobile-close')?.focus();
  else toggle?.focus();
};

document.addEventListener('click', (e) => {
  if (e.target.closest('.menu-toggle')) setMenu(true);
  if (e.target.closest('.mobile-close')) setMenu(false);
  if (e.target.closest('.mobile-nav a')) setMenu(false);
});

document.addEventListener('click', (e) => {
  if (e.target.closest('.header-cart-icon')) {
    openCart();
    return;
  }

  const modal = document.getElementById('cart-modal');
  if (modal && modal.classList.contains('open')) {
    if (e.target.closest('.close-cart') || e.target === modal) {
      closeCart();
      return;
    }
  }

  const action = e.target.closest('[data-cart-action]');
  if (action) {
    const row = action.closest('.cart-item');
    const key = row?.dataset.key;
    if (!key) return;

    if (action.dataset.cartAction === 'remove') {
      cart.removeItem(key);
    } else {
      const item = cart.getItems().find((entry) => entry.key === key);
      if (item) {
        const delta = action.dataset.cartAction === 'increase' ? 1 : -1;
        cart.setQuantity(key, item.quantity + delta);
      }
    }

    renderCartItems();
    updateCartCount();
    return;
  }

});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeCart(); setMenu(false); }
  const mobileNav = document.querySelector('.mobile-nav.open');
  if (e.key === 'Tab' && mobileNav) {
    const controls = [...mobileNav.querySelectorAll('a, button')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
