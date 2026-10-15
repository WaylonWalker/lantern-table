const installButton = document.querySelector("#installApp");
let installPrompt = null;

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch(error => {
    console.warn("Lantern Table could not enable offline app-shell support.", error);
  }));
}

const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

if (installButton && !isStandalone) {
  if (isIOS) {
    installButton.hidden = false;
    installButton.addEventListener("click", () => {
      window.alert("To install Lantern Table, tap Share in Safari, then choose “Add to Home Screen”.");
    });
  } else {
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      installPrompt = event;
      installButton.hidden = false;
    });
    installButton.addEventListener("click", async () => {
      if (!installPrompt) return;
      installButton.disabled = true;
      await installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      installButton.hidden = true;
      installButton.disabled = false;
    });
    window.addEventListener("appinstalled", () => {
      installPrompt = null;
      installButton.hidden = true;
    });
  }
}
