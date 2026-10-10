import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const Ask = createContext(() => Promise.resolve(false));

export const useConfirm = () => useContext(Ask);

// a native dialog gives focus trapping, Esc and an inert page behind it; cancel comes first so it takes the initial focus
export function ConfirmProvider({ children }) {
  const [open, setOpen] = useState(null);
  const dialog = useRef(null);

  const ask = useCallback((question, { yes = 'ok', danger = false } = {}) => (
    new Promise((resolve) => setOpen({ question, yes, danger, resolve }))
  ), []);

  useEffect(() => {
    if (open && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  const settle = (answer) => {
    dialog.current.close();
    open.resolve(answer);
    setOpen(null);
  };

  return (
    <Ask.Provider value={ask}>
      {children}
      <dialog
        ref={dialog}
        className="confirm"
        role="alertdialog"
        aria-labelledby="confirm-text"
        onCancel={(event) => { event.preventDefault(); settle(false); }}
        onClick={(event) => { if (event.target === event.currentTarget) settle(false); }}
      >
        {open && (
          <div className="confirm-body">
            <p id="confirm-text">{open.question}</p>
            <div className="buttons">
              <button type="button" className="secondary" onClick={() => settle(false)}>cancel</button>
              <button type="button" className={open.danger ? 'danger' : undefined} onClick={() => settle(true)}>{open.yes}</button>
            </div>
          </div>
        )}
      </dialog>
    </Ask.Provider>
  );
}
