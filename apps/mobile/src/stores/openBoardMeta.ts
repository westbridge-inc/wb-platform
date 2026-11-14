import { create } from 'zustand';
import type { OpenBoardMeta } from '../modules/vendor/openBoard';

/** [STORE-BOARD S1] The live board's last answer about itself (how many open orders it holds, and how many the
 *  server left out), for the note under the board. */
export const useOpenBoardMeta = create<{ meta: OpenBoardMeta | null }>(() => ({ meta: null }));
