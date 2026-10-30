// Explore Collection Logic
document.addEventListener('DOMContentLoaded', function() {
    const exploreBtn = document.getElementById('exploreBtn');
    const collectionSection = document.getElementById('collection');

    if (exploreBtn && collectionSection) {
        exploreBtn.addEventListener('click', function() {
            // Show the collection section
            collectionSection.style.display = 'block';

            // Smooth scroll to the collection
            collectionSection.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        });
    }
});

// Email Signup Form
document.getElementById('signupForm').addEventListener('submit', function(e) {
    e.preventDefault();

    const email = document.getElementById('email').value;

    if (email) {
        showNotification('Thank you! You\'ll be notified when we launch.', 'success');
        document.getElementById('email').value = '';
    }
});

// Notification System
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;

    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? 'var(--pastel-green)' : 'var(--pastel-pink)'};
        color: white;
        padding: 1rem 2rem;
        border-radius: 10px;
        box-shadow: 0 5px 20px var(--shadow-medium);
        z-index: 1000;
        transform: translateX(100%);
        transition: transform 0.3s ease;
        font-family: 'Poppins', sans-serif;
        font-weight: 500;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
    }, 100);

    setTimeout(() => {
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}

// Add some interactive effects
document.addEventListener('DOMContentLoaded', function() {
    // Add typing effect to tagline (optional)
    const tagline = document.querySelector('.tagline');
    if (tagline) {
        const text = tagline.textContent;
        tagline.textContent = '';
        let i = 0;

        function typeWriter() {
            if (i < text.length) {
                tagline.textContent += text.charAt(i);
                i++;
                setTimeout(typeWriter, 50);
            }
        }

        setTimeout(typeWriter, 1000);
    }
});

// Parallax effect for background (optional)
window.addEventListener('scroll', function() {
    const scrolled = window.pageYOffset;
    const background = document.querySelector('.background-animation');
    if (background) {
        background.style.transform = `translateY(${scrolled * 0.5}px)`;
    }
});
