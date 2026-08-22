// ==================================================
// Home Banner System — Banner Slider (Home page, user side)
// ==================================================
// Self-contained and additive: mounts only into #banner-slider-container
// (see index.html, placed right below the Profile section and right above
// the Live Rooms tab). Does not read from or modify app.js/index.html state
// in any other way.
//
//  - No banners  -> renders nothing
//  - 1 banner    -> shows the image only, no dots, no rotation
//  - 2+ banners  -> auto-slides every 3s, infinite loop, with dot indicators

(function () {
    const CONTAINER_ID = "banner-slider-container";
    const ROTATE_MS = 3000;

    function injectStyles() {
        if (document.getElementById("banner-slider-styles")) return;
        const style = document.createElement("style");
        style.id = "banner-slider-styles";
        style.textContent = `
#${CONTAINER_ID}{ width:100%; display:flex; justify-content:center; margin: 10px 0; }
.banner-slider{
  position:relative; width:95%; height:160px;
  border-radius:16px; overflow:hidden;
  box-shadow: var(--shadow-card, 0 10px 30px rgba(0,0,0,0.55));
  background: var(--bg-panel, #16101F);
}
.banner-slider-track{ position:relative; width:100%; height:100%; }
.banner-slide{
  position:absolute; inset:0; width:100%; height:100%;
  object-fit:cover; opacity:0; transition:opacity .4s ease; display:block;
}
.banner-slide.active{ opacity:1; }
.banner-slide.clickable{ cursor:pointer; }
.banner-slider-dots{
  position:absolute; left:0; right:0; bottom:8px;
  display:flex; justify-content:center; gap:6px; z-index:2;
}
.banner-slider-dot{
  width:6px; height:6px; border-radius:999px;
  background: rgba(255,255,255,0.45);
  transition: width .2s ease, background .2s ease;
}
.banner-slider-dot.active{
  width:16px;
  background: var(--accent-gold, #F7CE7E);
}
`;
        document.head.appendChild(style);
    }

    function goTo(track, dotsWrap, index) {
        const slides = track.querySelectorAll(".banner-slide");
        const dots = dotsWrap ? dotsWrap.querySelectorAll(".banner-slider-dot") : [];
        slides.forEach((s, i) => s.classList.toggle("active", i === index));
        dots.forEach((d, i) => d.classList.toggle("active", i === index));
    }

    function openBanner(linkUrl) {
        if (!linkUrl) return;
        const isExternal = /^https?:\/\//i.test(linkUrl);
        window.open(linkUrl, isExternal ? "_blank" : "_self");
    }

    function render(container, banners) {
        container.innerHTML = "";
        if (!banners || !banners.length) return; // no banners -> show nothing

        const slider = document.createElement("div");
        slider.className = "banner-slider";

        const track = document.createElement("div");
        track.className = "banner-slider-track";
        slider.appendChild(track);

        banners.forEach((b, i) => {
            const img = document.createElement("img");
            img.className = "banner-slide" + (i === 0 ? " active" : "") + (b.linkUrl ? " clickable" : "");
            img.src = b.imageUrl;
            img.alt = "";
            if (b.linkUrl) img.addEventListener("click", () => openBanner(b.linkUrl));
            track.appendChild(img);
        });

        let dotsWrap = null;
        if (banners.length > 1) {
            dotsWrap = document.createElement("div");
            dotsWrap.className = "banner-slider-dots";
            banners.forEach((_, i) => {
                const dot = document.createElement("div");
                dot.className = "banner-slider-dot" + (i === 0 ? " active" : "");
                dotsWrap.appendChild(dot);
            });
            slider.appendChild(dotsWrap);
        }

        container.appendChild(slider);

        // Static by design for the current Home rollout: no automatic movement.
        // Dots remain as a visual indicator; the room/content pane is the only
        // scrollable area on Home. This keeps the header stable on mobile WebView.
        if (banners.length > 1) {
            // Intentionally no setInterval/auto-slide here.
        }
    }

    async function loadBanners() {
        const container = document.getElementById(CONTAINER_ID);
        if (!container) return;
        try {
            const res = await fetch("/api/banners");
            const data = await res.json();
            render(container, data && data.success ? data.banners : []);
        } catch (err) {
            // Silent — a banner failure should never disrupt the Home page.
            render(container, []);
        }
    }

    injectStyles();
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", loadBanners);
    } else {
        loadBanners();
    }
})();
