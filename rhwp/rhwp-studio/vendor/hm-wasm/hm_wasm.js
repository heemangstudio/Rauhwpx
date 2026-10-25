/* @ts-self-types="./hm_wasm.d.ts" */

/**
 * BLAKE3 of bytes fed in pieces, for the host's document digests.
 */
export class Blake3Hasher {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Blake3HasherFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_blake3hasher_free(ptr, 0);
    }
    /**
     * The hash as lowercase hex; the hasher can go on taking bytes.
     * @returns {string}
     */
    finalizeHex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.blake3hasher_finalizeHex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    constructor() {
        const ret = wasm.blake3hasher_new();
        this.__wbg_ptr = ret;
        Blake3HasherFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} bytes
     */
    update(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.blake3hasher_update(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) Blake3Hasher.prototype[Symbol.dispose] = Blake3Hasher.prototype.free;

/**
 * An open document.
 */
export class Doc {
    static __wrap(ptr) {
        const obj = Object.create(Doc.prototype);
        obj.__wbg_ptr = ptr;
        DocFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DocFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_doc_free(ptr, 0);
    }
    /**
     * Takes `other`'s document in place of this one's, with an empty
     * history, and closes `other`. This document's checkpoints stay, so a
     * host can put back what it held before; the result counts as unsaved.
     * A `Receipt`.
     * @param {Doc} other
     * @returns {string}
     */
    adopt(other) {
        let deferred3_0;
        let deferred3_1;
        try {
            _assertClass(other, Doc);
            var ptr0 = other.__destroy_into_raw();
            const ret = wasm.doc_adopt(this.__wbg_ptr, ptr0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Takes the IME text out; a `Receipt` with the caret where it began,
     * or `null` when nothing was composing.
     * @returns {string}
     */
    cancelComposition() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_cancelComposition(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Keeps a drawing's placement and transform (its box, matrices,
     * rotation, flips and crop) under a handle, for `swapObjectTransform`.
     * @param {string} object
     * @returns {number}
     */
    captureObjectTransform(object) {
        const ptr0 = passStringToWasm0(object, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.doc_captureObjectTransform(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Keeps the document and its history to come back to; returns the
     * checkpoint's handle.
     * @returns {number}
     */
    checkpoint() {
        const ret = wasm.doc_checkpoint(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Releases the document; later calls fail with `CLOSED`.
     */
    close() {
        wasm.doc_close(this.__wbg_ptr);
    }
    /**
     * Ends the composition with `text` (the shown text when absent) as one
     * undo step; a `Receipt`.
     * @param {string} request
     * @returns {string}
     */
    commitComposition(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_commitComposition(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Shows IME text in progress at `at` (or where the composition began),
     * replacing the text shown before; laid out as typed text but kept out
     * of the history. Returns a `Receipt` whose caret ends the text.
     * @param {string} request
     * @returns {string}
     */
    compose(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_compose(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Copies `[from, to)` (`CopyRequest`) as `Copied` text and HTML for
     * the system clipboard. The fragment is shared by this Engine's
     * documents until the next copy, survives source closure, and carries
     * face names for paste into another document.
     * @param {string} request
     * @returns {string}
     */
    copy(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_copy(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Drops a kept transform; false when there was none.
     * @param {number} handle
     * @returns {boolean}
     */
    discardObjectTransform(handle) {
        const ret = wasm.doc_discardObjectTransform(this.__wbg_ptr, handle);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Every family [`Doc::font_requests`] names, as a JSON `string[]`.
     * @returns {string}
     */
    fontNames() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_fontNames(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * What fonts the document draws with (`FontRequests`): per face name
     * its text, paragraph heads and equations use, its candidate families
     * in the order the engine tries them and its font-map stand-ins; the
     * class default lists; and `fallbacks`, the unregistered families the
     * engine looks in, in order, for characters the registered faces lack.
     *
     * Register the first available candidate of each face and the first
     * available family of the first default list (Hancom's default face;
     * failing that, of the others), then ask again and register the
     * available fallbacks before the first layout. Doesn't lay the
     * document out. Once laid out, the faces also include every name the
     * layout asked for and the fallbacks what it looked for; registering
     * what is new and available lays it out again.
     * @returns {string}
     */
    fontRequests() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_fontRequests(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Paragraphs the last layout reused and formatted.
     * @returns {Float64Array}
     */
    layoutStats() {
        const ret = wasm.doc_layoutStats(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * A point to a position (`Located`), or a position to its caret
     * (`Caret`); `null` when nothing editable is there.
     * @param {string} request
     * @returns {string}
     */
    locate(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_locate(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Marks the document saved as it was at `expectedEpoch` (after the
     * host wrote what `serialize(false)` gave it); `STALE_EPOCH` when it
     * changed since. Changes nothing else.
     * @param {number} expected_epoch
     */
    markSaved(expected_epoch) {
        const ret = wasm.doc_markSaved(this.__wbg_ptr, expected_epoch);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The caret after a movement (`Located`), `null` when the position is
     * on no page.
     * @param {string} request
     * @returns {string}
     */
    navigate(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_navigate(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The body's floating objects and tables on page `i`
     * (`ObjectTarget[]`), bottom to top.
     * @param {number} i
     * @returns {string}
     */
    objects(i) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_objects(this.__wbg_ptr, i);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Page `i` as a packet (see [`packet`]).
     * @param {number} i
     * @returns {Uint8Array}
     */
    page(i) {
        const ret = wasm.doc_page(this.__wbg_ptr, i);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Metadata for just one page, without serializing the whole document.
     * @param {number} index
     * @returns {string}
     */
    pageInfo(index) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_pageInfo(this.__wbg_ptr, index);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Every object and table page `i` draws, in any paragraph list
     * (`PageObject[]`), bottom to top.
     * @param {number} i
     * @returns {string}
     */
    pageObjects(i) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_pageObjects(this.__wbg_ptr, i);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Page `i` rasterized by the engine as PNG, the reference the canvas
     * player is checked against.
     * @param {number} i
     * @param {number} dpi
     * @returns {Uint8Array}
     */
    pagePng(i, dpi) {
        const ret = wasm.doc_pagePng(this.__wbg_ptr, i, dpi);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Page `i` as an SVG document: text and rules as vectors, pictures
     * and brushes as PNG patches at `dpi`.
     * @param {number} i
     * @param {number} dpi
     * @returns {string}
     */
    pageSvg(i, dpi) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_pageSvg(this.__wbg_ptr, i, dpi);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * `PageInfo[]` as JSON, sizes in HU.
     * @returns {string}
     */
    pages() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_pages(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Pastes at `at`, or over `replace` (one list), as one undo step
     * (`PasteRequest`): the engine's fragment when `text` is absent or is
     * the fragment's text, else `text` as typed. A `Receipt` with the caret
     * after the paste; on failure nothing changes, epochs included.
     * @param {string} request
     * @returns {string}
     */
    paste(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_paste(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Pixels of patch op `item` of page `i` at `dpi`: `u32` width and
     * height, then straight RGBA rows; empty when it draws nothing.
     * @param {number} i
     * @param {number} item
     * @param {number} dpi
     * @returns {Uint8Array}
     */
    patch(i, item, dpi) {
        const ret = wasm.doc_patch(this.__wbg_ptr, i, item, dpi);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Pages `from..to` as one PDF for printing or export: text and rules
     * as vectors, pictures and brushes as images at `dpi`.
     * @param {number} from
     * @param {number} to
     * @param {number} dpi
     * @returns {Uint8Array}
     */
    pdf(from, to, dpi) {
        const ret = wasm.doc_pdf(this.__wbg_ptr, from, to, dpi);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The bytes of the picture [`Doc::picture_source`] describes: the file
     * as stored, or straight RGBA rows for `image/x-rgba`.
     * @param {number} i
     * @param {number} item
     * @returns {Uint8Array}
     */
    pictureBytes(i, item) {
        const ret = wasm.doc_pictureBytes(this.__wbg_ptr, i, item);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Patch op `item` of page `i` as a picture the host decodes and
     * scales itself (`PictureSource`), or `null` when the patch has to be
     * rendered by [`Doc::patch`]. JPEG, PNG, GIF and BMP files come as
     * stored; other raster formats as straight RGBA rows
     * (`image/x-rgba`). Hosts decode such pictures off the critical path,
     * so a first paint need not wait for the engine to decode and
     * resample them.
     * @param {number} i
     * @param {number} item
     * @returns {string}
     */
    pictureSource(i, item) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_pictureSource(this.__wbg_ptr, i, item);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Bounded reads of the document (`QueryRequest`), as JSON:
     * `paragraphs` gives `ParagraphInfo[]` for a list, `formatContext` a
     * `FormatContext`, `styles` `StyleInfo[]` and `style` one (or null),
     * `lists` `ListInfo[]` and `list` one (or null), `count` a
     * `CharacterCount` and `formatRuns` `ParagraphFormat[]`.
     * @param {string} request
     * @returns {string}
     */
    query(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_query(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Applies the last undone transaction again; like [`Doc::undo`].
     * @returns {string}
     */
    redo() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_redo(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Drops a checkpoint; false when there was none.
     * @param {number} checkpoint
     * @returns {boolean}
     */
    releaseCheckpoint(checkpoint) {
        const ret = wasm.doc_releaseCheckpoint(this.__wbg_ptr, checkpoint);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Puts back a checkpoint's document and history, keeping the
     * checkpoint; a `Receipt`.
     * @param {number} checkpoint
     * @returns {string}
     */
    restore(checkpoint) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_restore(this.__wbg_ptr, checkpoint);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Text matches within paragraphs (`SearchRequest` to `SearchResult`),
     * in document order: each list, then the lists its paragraphs' controls
     * hold. Doesn't lay the document out.
     * @param {string} request
     * @returns {string}
     */
    search(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_search(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Selection rectangles (`Rect[]`) for `[from, to)` in one list.
     * @param {string} request
     * @returns {string}
     */
    select(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_select(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Like [`Doc::select`], with the selection as normalized
     * (`Selected`): the text range in the common list, or the block of
     * cells with each cell's list.
     * @param {string} request
     * @returns {string}
     */
    selectRange(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_selectRange(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The document in its own format, edited paragraphs carrying line
     * segments from our layout. `markSaved` clears the dirty state; the
     * content epoch never changes.
     * @param {boolean} mark_saved
     * @returns {Uint8Array}
     */
    serialize(mark_saved) {
        const ret = wasm.doc_serialize(this.__wbg_ptr, mark_saved);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The document written as `format` (`"hwp5"` or `"hwpx"`): in its
     * own format as [`Doc::serialize`] writes it, in the other as a new
     * file encoded from the model alone. The open document keeps its
     * format; `markSaved` clears the dirty state.
     * @param {string} format
     * @param {boolean} mark_saved
     * @returns {Uint8Array}
     */
    serializeAs(format, mark_saved) {
        const ptr0 = passStringToWasm0(format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.doc_serializeAs(this.__wbg_ptr, ptr0, len0, mark_saved);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * `DocState` as JSON.
     * @returns {string}
     */
    state() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_state(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Face names that resolved to another family, as `requested\tused`
     * lines: the fonts worth providing.
     * @returns {string}
     */
    substitutions() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_substitutions(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Exchanges a kept transform with the object's current one as one
     * undo step, keeping the current one under the same handle; a
     * `Receipt`.
     * @param {number} handle
     * @returns {string}
     */
    swapObjectTransform(handle) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_swapObjectTransform(this.__wbg_ptr, handle);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Applies edits atomically as one undo step and lays out again;
     * returns a `Receipt`. With `expectedEpoch` set, a document edited
     * since fails with `STALE_EPOCH` and nothing changes.
     * @param {string} request
     * @returns {string}
     */
    transact(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.doc_transact(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Reverts the last transaction; a `Receipt`, or `null` when there is
     * nothing to undo.
     * @returns {string}
     */
    undo() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.doc_undo(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) Doc.prototype[Symbol.dispose] = Doc.prototype.free;

/**
 * Fonts shared by the documents an engine opens.
 */
export class Engine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engine_free(ptr, 0);
    }
    /**
     * Registers a Hancom code conversion table (`u300_*.dat`).
     * @param {Uint8Array} bytes
     * @returns {boolean}
     */
    addCodeTable(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_addCodeTable(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Registers a TTF, OTF, TTC or HFT file; returns the faces added.
     * Documents lay out again with it on their next request.
     *
     * The engine keeps of a TrueType face its metrics and the outlines of
     * the characters in the documents opened so far, not the file. Other
     * outlines come empty (`em` 0 in `glyphOutlines`) and name the file in
     * [`Engine::outline_requests`]; registering the same label again fills
     * them in and bumps the font generation, without a new layout unless
     * one measured a missing outline.
     * @param {string} label
     * @param {Uint8Array} bytes
     * @returns {number}
     */
    addFont(label, bytes) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.engine_addFont(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret >>> 0;
    }
    /**
     * Registers a font file the host holds, like [`Engine::add_font`],
     * reading through `file.read(offset, length)` (a `Uint8Array`) only
     * the parts the engine keeps, so the file never enters the engine's
     * memory whole.
     * @param {string} label
     * @param {FontFileSource} file
     * @returns {number}
     */
    addFontFile(label, file) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_addFontFile(this.__wbg_ptr, ptr0, len0, file);
        return ret >>> 0;
    }
    /**
     * Registers Hancom's font mapping table (`FontMap.dat`).
     * @param {Uint8Array} bytes
     * @returns {boolean}
     */
    addFontMap(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_addFontMap(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Registers Hancom's HFT catalog (`hftinfo.dat`), before HFT files.
     * @param {Uint8Array} bytes
     * @returns {boolean}
     */
    addHftInfo(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_addHftInfo(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * A new document from a template: the template's pages, styles,
     * headers and footers, with each section's text emptied to one
     * paragraph and no history.
     * @param {Uint8Array} template
     * @returns {Doc}
     */
    create(template) {
        const ptr0 = passArray8ToWasm0(template, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_create(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Doc.__wrap(ret[0]);
    }
    /**
     * Bytes of font data the engine holds.
     * @returns {number}
     */
    get fontBytes() {
        const ret = wasm.engine_fontBytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get fontGeneration() {
        const ret = wasm.engine_fontGeneration(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Outlines for `(face, glyph)` pairs as a page's `GLYF` block lists
     * them (see [`packet::glyph_outlines`]).
     * @param {Uint32Array} pairs
     * @returns {Uint8Array}
     */
    glyphOutlines(pairs) {
        const ptr0 = passArray32ToWasm0(pairs, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_glyphOutlines(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    constructor() {
        const ret = wasm.engine_new();
        this.__wbg_ptr = ret;
        EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Opens HWP 5, HWPX or HWP 3 bytes and lays them out.
     * @param {Uint8Array} bytes
     * @returns {Doc}
     */
    open(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_open(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Doc.__wrap(ret[0]);
    }
    /**
     * Labels of registered font files with outlines asked for but not
     * kept, as a JSON `string[]`: register each again with its bytes.
     * @returns {string}
     */
    outlineRequests() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_outlineRequests(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Unregisters the font files registered under the labels of a JSON
     * `string[]`; returns the faces removed. Documents lay out again on
     * their next request.
     * @param {string} labels
     * @returns {number}
     */
    unregisterFonts(labels) {
        const ptr0 = passStringToWasm0(labels, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_unregisterFonts(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
}
if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;

/**
 * A failure JS can tell apart by `code`.
 */
export class EngineError {
    static __wrap(ptr) {
        const obj = Object.create(EngineError.prototype);
        obj.__wbg_ptr = ptr;
        EngineErrorFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineErrorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engineerror_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get code() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engineerror_code(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get message() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engineerror_message(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engineerror_toString(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) EngineError.prototype[Symbol.dispose] = EngineError.prototype.free;

/**
 * Decompresses a Brotli stream, such as a WOFF2 font's tables, into at
 * most `max` bytes. Browsers without a Brotli `DecompressionStream` read
 * web fonts through this.
 * @param {Uint8Array} bytes
 * @param {number} max
 * @returns {Uint8Array}
 */
export function brotliDecompress(bytes, max) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.brotliDecompress(ptr0, len0, max);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * What this build offers, as JSON (`Capabilities`).
 * @returns {string}
 */
export function capabilities() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.capabilities();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * The family names of a font file (TTF, OTF, TTC or HFT) as a JSON
 * `string[]`, for a host's font catalog; empty when unreadable.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function familyNames(bytes) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.familyNames(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * [`family_names`] of a file the host holds, reading only its tables.
 * @param {FontFileSource} file
 * @returns {string}
 */
export function fileFamilyNames(file) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.fileFamilyNames(file);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_ea4887a5f8f9a9db: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_engineerror_new: function(arg0) {
            const ret = EngineError.__wrap(arg0);
            return ret;
        },
        __wbg_read_c55db76f6b46a767: function(arg0, arg1, arg2, arg3) {
            const ret = arg1.read(arg2, arg3);
            const ptr1 = passArray8ToWasm0(ret, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_size_101b30e504ca589b: function(arg0) {
            const ret = arg0.size;
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./hm_wasm_bg.js": import0,
    };
}

const Blake3HasherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blake3hasher_free(ptr, 1));
const DocFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_doc_free(ptr, 1));
const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));
const EngineErrorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engineerror_free(ptr, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('hm_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
