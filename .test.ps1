$env:PORT='4020'
Start-Process node -ArgumentList 'c:\Users\nguye\Desktop\Filmlo\server.js' -RedirectStandardOutput 'c:\Users\nguye\Desktop\Filmlo\.srv.log' -RedirectStandardError 'c:\Users\nguye\Desktop\Filmlo\.srv.err.log' -PassThru | Select-Object Id
Start-Sleep 2
foreach ($u in @('/api/movie/thiep-von-chi-la-co-rac','/api/movies?page=1','/api/filter/phim-le?page=1','/api/categories')) {
  try {
    $r = Invoke-WebRequest ("http://127.0.0.1:4020" + $u) -UseBasicParsing
    $j = $r.Content | ConvertFrom-Json
    Write-Output "$u -> $($r.StatusCode) success=$($j.success) movie=$($null -ne $j.movie) episodes=$($j.episodes.Count)"
  } catch {
    Write-Output "$u ERR $($_.Exception.Message)"
  }
}
