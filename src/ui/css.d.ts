// Allow side-effect CSS imports (e.g. '@xyflow/react/dist/style.css') in the
// UI project. The host bundler handles the actual CSS; tsc just needs the shape.
declare module '*.css'
