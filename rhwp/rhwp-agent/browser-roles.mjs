// Keep discovery limited to the existing control roles; role fallback does not grant input permission.
const CONTROL_ROLES = ['button', 'link', 'textbox', 'menuitem', 'option', 'tab'];
export const BROWSER_CONTROL_SELECTOR = `a[href],button,input,textarea,select,${CONTROL_ROLES.map(role => `[role~="${role}"]`).join(',')},[contenteditable="true"],summary`;

// Concrete ARIA roles supported by the browser. Abstract roles cannot win a fallback list.
const ARIA_ROLES = new Set('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'.split(' '));
const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox' };
const TAG_ROLES = { a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', summary: 'button' };

export function browserRole(value, tag, inputType) {
  const explicit = String(value ?? '').split(/[\t\n\f\r ]+/).find(role => ARIA_ROLES.has(role));
  return explicit || (tag === 'input' ? INPUT_ROLES[inputType] : TAG_ROLES[tag]) || 'textbox';
}
