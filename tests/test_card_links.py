"""Card links must open in a new browser tab."""

from smarthole.apkg_import import render_plain_text, sanitize


def test_sanitize_forces_links_to_new_tab():
    out = sanitize('<p>See <a href="https://example.com">docs</a></p>')
    assert 'target="_blank"' in out
    assert 'rel="noopener noreferrer"' in out
    assert 'href="https://example.com"' in out


def test_sanitize_keeps_explicit_target_but_ensures_rel():
    out = sanitize('<a href="https://example.com" target="_self">x</a>')
    assert 'target="_self"' in out
    assert 'target="_blank"' not in out
    assert 'rel="noopener noreferrer"' in out


def test_markdown_link_renders_with_new_tab_target():
    out = render_plain_text("Read [the docs](https://example.com/a) now")
    assert 'href="https://example.com/a"' in out
    assert 'target="_blank"' in out
    assert 'rel="noopener noreferrer"' in out


def test_plain_text_without_links_gets_no_target():
    assert "target" not in render_plain_text("Just **bold** text")
