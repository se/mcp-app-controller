import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'appctrl-theme'

interface ThemeContextValue {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  resolved: 'dark',
  setTheme: () => {},
})

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolve(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme) || 'system'
  )
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolve(theme))

  useEffect(() => {
    const apply = () => {
      const r = resolve(theme)
      setResolved(r)
      document.documentElement.classList.toggle('dark', r === 'dark')
    }
    apply()
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  const setTheme = (t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t)
    setThemeState(t)
  }

  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  return useContext(ThemeContext)
}
