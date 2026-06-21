// PenSizeColor.js
// Centralized pen size & colour state, wired to the toolbar colour swatches
// and the size slider.  Other modules read these values off the window object.

(function () {
  'use strict';

  // ---- shared state (attached to window so PenStroke.js etc. can see them) ----
  window.penColor = '#000000';
  window.penWidth = 9; // logical size (matches slider value 4 → 9px via sliderToWidth)

  // ---- DOM refs ----
  var colorBtn      = document.querySelector('.color-btn');
  var dropdown      = document.querySelector('.color-picker-dropdown');
  var swatches      = document.querySelectorAll('.color-swatch');
  var sizePicker    = document.getElementById('sizePicker');
  var sizeValueSpan = document.getElementById('sizeValue');

  // ---- size mapping (slider 1–10 → pixel width) ----
  function sliderToWidth(val) {
    // linear: 1 → 2px, 10 → 24px
    return Math.round(2 + (val - 1) * (22 / 9));
  }

  // ---- initialise from the slider's current value ----
  function initSize() {
    var raw = parseInt(sizePicker.value, 10) || 4;
    window.penWidth = sliderToWidth(raw);
    sizeValueSpan.textContent = window.penWidth;
  }

  // ---- colour swatch events ----
  function onSwatchClick(e) {
    var swatch = e.currentTarget;
    var color  = swatch.getAttribute('data-color');
    if (!color) return;

    // update global state
    window.penColor = color;

    // update button preview
    colorBtn.style.backgroundColor = color;

    // update active class on swatches
    swatches.forEach(function (s) { s.classList.remove('active'); });
    swatch.classList.add('active');

    // close dropdown
    dropdown.classList.remove('open');
  }

  // ---- size slider events ----
  function onSizeChange() {
    var raw  = parseInt(sizePicker.value, 10) || 4;
    var w    = sliderToWidth(raw);
    window.penWidth = w;
    sizeValueSpan.textContent = w;

    // also push the new size into the live smoother instance
    if (window.strokeSmoother) {
      window.strokeSmoother.opts.size = w;
    }
  }

  // ---- colour-picker dropdown toggle ----
  function onColorBtnClick(e) {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  }

  // ---- close dropdown when clicking outside ----
  function onDocumentClick(e) {
    if (!e.target.closest('.color-picker-wrap')) {
      dropdown.classList.remove('open');
    }
  }

  // ---- attach events ----
  swatches.forEach(function (s) { s.addEventListener('click', onSwatchClick); });
  colorBtn.addEventListener('click', onColorBtnClick);
  sizePicker.addEventListener('input',  onSizeChange);
  sizePicker.addEventListener('change', onSizeChange);
  document.addEventListener('click', onDocumentClick);

  // ---- initialise ----
  initSize();

  // ---- expose the mapping for other modules that need it ----
  window.sliderToWidth = sliderToWidth;

})();