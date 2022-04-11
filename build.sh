#!/usr/bin/env bash

declare -a arr=(
  "auto-tag" 
  "get-artifacts-info"
  "get-pr-info"
  "local-server-script"
  "notice-slack-app-update"
  "qiniu-upload" 
  "update-android-version-file"
  "upload-artifact-firim"
  "upload-artifact-firim-js"
  "build-gradle-edit"
  "build-plist-edit"
  )

for i in "${arr[@]}"
do
  folder='./'$i'/src'

  if [[ -d $folder ]] 
  then
    cd $folder
    echo '=============== build '$folder' ==============='
    yarn && yarn build
    cd -
  fi

  echo ''
done



