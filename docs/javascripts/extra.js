document$.subscribe(() => {
  const codeBlocks = document.querySelectorAll('.highlight');
  codeBlocks.forEach((block) => block.setAttribute('data-core-channel', 'HVC'));
});
