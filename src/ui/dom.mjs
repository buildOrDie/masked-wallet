// DOM lookups for the views and controllers (typed loosely: the screens know what they put there).

/** @returns {any} the first element matching `selector`, or null */
export const $ = (selector, root = document) => root.querySelector(selector);

/** @returns {any[]} every element matching `selector` */
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
