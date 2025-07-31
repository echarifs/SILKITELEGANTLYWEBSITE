# SilkItElegantly - Coming Soon Website

A beautiful, responsive "Coming Soon" website for the SilkItElegantly brand featuring pastel colors and elegant design.

## Features

- ✨ Beautiful pastel color palette (green, yellow, golden, pink, blue)
- 🎨 Animated gradient background
- ⏰ Interactive countdown timer
- 📧 Email signup form
- 📱 Fully responsive design
- 🎯 Modern glassmorphism effects
- 🔗 Social media links

## Files Structure

```
SILKITELEGANTLYWEBSITE/
├── index.html          # Main HTML file
├── styles.css          # CSS styles with pastel colors
├── script.js           # JavaScript functionality
├── SilkItLogos/        # Your brand logos
└── README.md           # This file
```

## Setup Instructions

1. **Upload to your web server** or hosting service
2. **Update the countdown date** in `script.js` (line 4):
   ```javascript
   const launchDate = new Date(2025, 0, 15, 12, 0, 0).getTime();
   ```
   - Year: 2025
   - Month: 0 (January) - Note: months are 0-indexed
   - Day: 15
   - Hour: 12 (noon)
   - Minute: 0
   - Second: 0

3. **Customize your logo** by replacing `SilkItLogos/logo.png` with your preferred logo

4. **Update social media links** in `index.html` (lines 58-61):
   ```html
   <a href="YOUR_INSTAGRAM_URL" class="social-link"><i class="fab fa-instagram"></i></a>
   <a href="YOUR_FACEBOOK_URL" class="social-link"><i class="fab fa-facebook"></i></a>
   <a href="YOUR_TWITTER_URL" class="social-link"><i class="fab fa-twitter"></i></a>
   <a href="YOUR_TIKTOK_URL" class="social-link"><i class="fab fa-tiktok"></i></a>
   ```

## Customization Options

### Colors
The pastel color palette is defined in `styles.css` at the top:
```css
:root {
    --pastel-green: #A8E6CF;
    --pastel-yellow: #FFEAA7;
    --pastel-golden: #FFD93D;
    --pastel-pink: #FFB6C1;
    --pastel-blue: #B8E6B8;
}
```

### Text Content
Update the following in `index.html`:
- Brand title: "SilkItElegantly"
- Tagline: "Where Elegance Meets Innovation"
- Coming soon message
- Email signup text

### Logo
Replace `SilkItLogos/logo.png` with any of your available logos:
- `logo.png` (current)
- `silkit.png`
- `silkiiittt.png`
- `silkitfleuri.png`
- Or any other logo from your folder

## Next Steps for Full Website

After the coming soon page, you can expand to include:

1. **Home Page** - Main landing page with your story
2. **Products Gallery** - Showcase your silk products with photos
3. **About Page** - Your brand story and mission
4. **Contact Page** - Contact form and information
5. **Shop/E-commerce** - If you plan to sell online

## Technical Notes

- **Fonts**: Uses Google Fonts (Playfair Display & Poppins)
- **Icons**: Font Awesome for social media icons
- **Animations**: CSS animations for smooth effects
- **Responsive**: Works on all device sizes
- **Performance**: Optimized for fast loading

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge
- Mobile browsers

## Contact

For any questions or customizations, feel free to reach out!

---

**SilkItElegantly** - Where Elegance Meets Innovation ✨ 