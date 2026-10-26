// Accounts of one recovery phrase: their names, which ones are hidden, and which one is open. Labels only:
// the keys always come from the phrase (Keyring.fromMnemonic with the account number), so nothing here is secret.
// Filed under the phrase's master key fingerprint, so another wallet on this device has its own list.

export const MAX_ACCOUNTS = 100;
const NAME_MAX = 24;

/** @typedef {{ i: number, name: string, hidden?: boolean, birthday?: number|null, fresh?: boolean }} AccountEntry */

export class AccountBook {
  /** @param {import('../core/LocalStore.mjs').LocalStore} store */
  constructor(store) { this.store = store; }

  key(fp) { return `wren.accounts.${fp}`; }

  /** @returns {{ active: number, list: AccountEntry[] }} */
  read(fp) {
    const d = this.store.getJson(this.key(fp), null);
    const list = Array.isArray(d?.list) ? d.list.filter((a) => Number.isInteger(a?.i) && a.i >= 0) : [];
    if (!list.some((a) => a.i === 0)) list.unshift({ i: 0, name: 'Account 1' });
    list.sort((a, b) => a.i - b.i);
    const active = list.some((a) => a.i === d?.active && !a.hidden) ? d.active : 0;
    return { active, list };
  }
  write(fp, d) { this.store.setJson(this.key(fp), d); }

  list(fp) { return this.read(fp).list; }
  visible(fp) { return this.list(fp).filter((a) => !a.hidden); }
  active(fp) { return this.read(fp).active; }
  /** @returns {AccountEntry} */
  entry(fp, i) { return this.list(fp).find((a) => a.i === i) || { i, name: `Account ${i + 1}`, birthday: null, fresh: false }; }
  name(fp, i) { return this.entry(fp, i).name; }

  setActive(fp, i) {
    const d = this.read(fp);
    if (!d.list.some((a) => a.i === i)) throw new Error('No such account');
    d.active = i; d.list.find((a) => a.i === i).hidden = false;
    this.write(fp, d);
  }

  /**
   * The next account. Its Shielded side is new (nothing to look back for), so its history scan starts now.
   * @returns {AccountEntry}
   */
  add(fp, name = '') {
    const d = this.read(fp);
    if (d.list.length >= MAX_ACCOUNTS) throw new Error(`Up to ${MAX_ACCOUNTS} accounts.`);
    const i = Math.max(...d.list.map((a) => a.i)) + 1;
    const entry = { i, name: AccountBook.clean(name) || `Account ${i + 1}`, birthday: Date.now(), fresh: true };
    d.list.push(entry);
    this.write(fp, d);
    return entry;
  }

  rename(fp, i, name) {
    const n = AccountBook.clean(name);
    if (!n) throw new Error('Enter a name.');
    const d = this.read(fp);
    const a = d.list.find((x) => x.i === i);
    if (!a) throw new Error('No such account');
    a.name = n;
    this.write(fp, d);
  }

  /** Hide from the list (the account and its coins stay; "Show hidden" brings it back). */
  hide(fp, i, hidden = true) {
    const d = this.read(fp);
    const a = d.list.find((x) => x.i === i);
    if (!a) throw new Error('No such account');
    if (hidden && d.active === i) throw new Error('Switch to another account before hiding this one.');
    if (hidden && d.list.filter((x) => !x.hidden).length <= 1) throw new Error('Keep at least one account visible.');
    a.hidden = hidden;
    this.write(fp, d);
  }

  static clean(name) { return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX); }
}
