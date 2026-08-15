## 2024-08-15 - Frequent DOM Repaints using innerHTML
**Learning:** Rebuilding table innerHTML inside a fast polling loop (like in the dashboard polling) causes expensive browser reflow and re-render cycles, harming frontend performance.
**Action:** When updating a fixed number of DOM elements in a tight loop, generate the DOM structure once during initialization, and update only the individual cell `.textContent` or `.className` references in the loop.
