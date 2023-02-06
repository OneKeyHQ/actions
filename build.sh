#!/usr/bin/env bash

declare -a arr=(
  "notice-slack-app-update"
  "build-gradle-edit"
  "build-plist-edit"
  "s3-upload"
  "dotenv-action"
  "expo-server"
  "gh-pages"
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
