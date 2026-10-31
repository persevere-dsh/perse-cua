# Preview test bench

Run `npm run preview:bench` and open the printed loopback URL. The page mounts the actual preview client with three local test windows; it does not start DSH, use a model, or connect to an external service. Select a window to change its frame or cycle through landscape, portrait, wide and square images. Scroll the top toolbar horizontally on narrow screens to reach every control. Use the preview's own controls to switch, expand and close windows. Enable “Fail close requests” to exercise the error display; restore the three windows with the page button. Set `PERSE_BENCH_PORT` to choose a local port, or omit it for an available port. Stop the server with Ctrl-C.

`npm run test:preview-bench` tests the fixture stream, server and real React component. Browser layout, pointer interaction and accessibility still require a browser check. The server listens only on `127.0.0.1` and builds assets in a temporary directory that it removes on exit.
