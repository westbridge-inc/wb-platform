// ---------------------------------------------------------------------------
// [STORE-BOARD S1 · perf budget] What the dashboard shell loads after the page has drawn, as ONE chunk: the other
// tabs' first reads (lib/dashboard-tab-reads) and the new-order ring (components/store-ring). Each async chunk adds an
// entry to the build's chunk map, which every page of the site loads (the customer pages' first load included), so
// the ring rides in the chunk the shell already fetched instead of adding one of its own.
// ---------------------------------------------------------------------------

export { dashboardTabReads, prefetchWhenIdle } from '@/lib/dashboard-tab-reads';
export { StoreRing } from '@/components/store-ring';
