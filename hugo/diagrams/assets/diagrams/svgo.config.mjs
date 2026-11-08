// Prepares an exported icon for a project pack: styles become attributes,
// editor data goes, classes go. Run: npx svgo@4.0.2 --config svgo.config.mjs -i in.svg -o out.svg
// It lives under assets/ so Hugo Modules vendor it with the rest of the module.
export default {
  multipass: true,
  plugins: [
    { name: 'inlineStyles', params: { onlyMatchedOnce: false } },
    'convertStyleToAttrs',
    'removeStyleElement',
    'removeEditorsNSData',
    'removeMetadata',
    'removeComments',
    { name: 'removeAttrs', params: { attrs: ['class', 'data-.*', 'style'] } },
    { name: 'preset-default', params: { overrides: { removeViewBox: false, inlineStyles: false } } },
  ],
};
