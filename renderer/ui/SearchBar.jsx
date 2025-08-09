import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiFilter, FiPlus, FiDownload, FiCheck } from 'react-icons/fi';

function useClickOutside(ref, onClose) {
  useEffect(() => {
    function handler(e){ if(ref.current && !ref.current.contains(e.target)) onClose?.(); }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onClose]);
}

function SearchBar({ mountNode, categories }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(new Set(['All']));
  const ddRef = useRef(null);

  useClickOutside(ddRef, () => setOpen(false));

  useEffect(() => {
    mountNode.dispatchEvent(new CustomEvent('search:change', { detail: query, bubbles: true }));
  }, [query, mountNode]);

  useEffect(() => {
    mountNode.dispatchEvent(
      new CustomEvent('filters:change', { detail: Array.from(selected), bubbles: true })
    );
  }, [selected, mountNode]);

  useEffect(() => {
    if (!categories || !categories.length) return;
    setSelected(prev => {
      if (prev.has('All')) return prev;
      const next = new Set([...prev].filter(c => categories.includes(c)));
      return next.size ? next : new Set(['All']);
    });
  }, [categories]);

  function toggle(cat) {
    setSelected(prev => {
      const next = new Set(prev);
      if (cat === 'All') return new Set(['All']);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      if (next.size === 0) next.add('All');
      if (next.has('All') && next.size > 1) { next.delete('All'); }
      return next;
    });
  }

  const pickedCount = selected.has('All') ? 0 : selected.size;

  return (
    <div className="searchbar" style={{ position: 'relative'}}>
      <input
        className="search-input"
        placeholder="Search transactions..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="search-sep" />

      <button
        id="filter"
        className="search-btn icon-btn"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        title="Filter"
      >
        <FiFilter className="icon" />
        {pickedCount > 0 && <span className="badge">{pickedCount}</span>}
      </button>

      <button
        id="add"
        className="search-btn icon-btn"
        onClick={() => mountNode.dispatchEvent(new CustomEvent('add:click', { bubbles:true }))}
        title="Add"
      >
        <FiPlus className="icon" />
      </button>

      <button
        id="download"
        className="search-btn icon-btn"
        onClick={() => mountNode.dispatchEvent(new CustomEvent('export:click', { bubbles:true }))}
        title="Export"
      >
        <FiDownload className="icon" />
      </button>

      {open && (
        <div className="dropdown" ref={ddRef} role="menu" aria-label="Filters">
          <div className="dropdown-title">Categories</div>
          <button className="dropdown-item" onClick={() => toggle('All')}>
            <span className="checkbox">{selected.has('All') && <FiCheck />}</span>
            All
          </button>
          {categories?.length ? categories.map(cat => (
            <button key={cat} className="dropdown-item" onClick={() => toggle(cat)}>
              <span className="checkbox">{selected.has(cat) && <FiCheck />}</span>
              {cat}
            </button>
          )) : null}
        </div>
      )}
    </div>
  );
}

export function mountSearchBar(node, opts = {}) {
  const root = createRoot(node);
  let cats = Array.isArray(opts.categories) ? [...new Set(opts.categories)].sort() : [];

  const render = () => root.render(<SearchBar mountNode={node} categories={cats} />);

  render();

  return {
    setCategories(next) {
      cats = Array.isArray(next) ? [...new Set(next)].sort() : [];
      render();
    },
    unmount() { root.unmount(); }
  };
}
