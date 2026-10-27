describe('scanner catches an intentionally untranslated JSX string', () => {
  it('reports visible English text so CI fails on the fixture', () => {
    const offenders = findEnglishLiterals('<button>Intentionally untranslated</button>');
    expect(offenders).toEqual([
      { line: 1, kind: 'text', text: 'Intentionally untranslated' },
    ]);
  });
});
