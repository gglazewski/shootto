// closeX.js — the × button every settings dialog wears in its top-right
// corner, so closing is always one visible click (Esc and the backdrop
// still work as before). Styled by .modal-x in index.html.

/**
 * @param {Document} doc
 * @param {() => void} onClose
 * @returns {HTMLButtonElement}
 */
export function closeX(doc, onClose) {
  const btn = doc.createElement('button');
  btn.className = 'modal-x';
  btn.title = 'Close (Esc)';
  btn.textContent = '×';
  btn.addEventListener('click', onClose);
  return btn;
}
