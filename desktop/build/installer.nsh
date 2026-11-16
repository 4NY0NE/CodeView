; Substitui a verificação padrão de "aplicativo em execução" do instalador:
; em vez de pedir para a pessoa fechar o CodeView (inclusive o que fica na bandeja), encerra o processo e segue.
!macro customCheckAppRunning
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 1500
!macroend
