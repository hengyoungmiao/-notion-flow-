import { App as AntApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useSystemDark } from './api'
import './styles.css'

function Root() {
  const dark = useSystemDark()
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#4f46e5', borderRadius: 8, fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Segoe UI", system-ui, sans-serif' }
      }}
    >
      <AntApp>
        <div className={dark ? 'app dark' : 'app'}>
          <App />
        </div>
      </AntApp>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
