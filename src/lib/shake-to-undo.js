/* global navigator */

// iOS offers to undo typing ("Undo Typing") whenever the phone is shaken, and bumps
// shake a phone mounted on handlebars all ride long. Only a page load makes iOS forget
// the typing, so once an address has been typed, the planning page reloads itself after
// putting the route in the URL, before a ride can start.
let typedAddress = false;

export function noteAddressTyped() {
  typedAddress = true;
}

function isIOS() {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS asks for desktop sites, so it reports itself as a Mac.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function shouldReloadToForgetTyping() {
  return typedAddress && isIOS();
}
