## changelog-en

### Deploy image retention keeps the current release plus N previous (DEPLOY-HYGIENE, OPE-5107)

- `deploy_image_retention` (deploy.sh step 11, bot-image-rollout.sh step 6b) counted its `MYRMIDON_DEPLOY_IMAGE_KEEP` window over the images no container uses and kept the first `keep + 1` of them. The release a container runs never entered that window, so for the bot images (`myrmidon-hermes`, `-hermes-dev`, `-hermes-node`: pulled by digest, no tags) the window kept two superseded generations on top of the running one. On the production host four generations of each bot image piled up (2.9 + 1.6 + 1.2 GB per generation); the rc.41 and rc.42 deploys logged «0 image(s) removed» and the disk fell to 8% free.
- The window now matches the setting: the current release plus `MYRMIDON_DEPLOY_IMAGE_KEEP` previous ones, per repository. The newest image a container uses is the current release and stays; images newer than it (just pulled, not started yet) always stay and are not counted; after the current release at most `keep` unused images stay, every older unused image is removed. A repository with no used image keeps the `keep + 1` newest as before. An image any container uses is still never removed.
- The summary line now also names how many newer-than-running images were kept.

## changelog-ru

### Очистка образов после выката оставляет текущий выпуск и N предыдущих (DEPLOY-HYGIENE, OPE-5107)

- `deploy_image_retention` (шаг 11 deploy.sh, шаг 6b bot-image-rollout.sh) считала окно `MYRMIDON_DEPLOY_IMAGE_KEEP` только по образам, которых не занимает ни один контейнер, и оставляла первые `keep + 1` из них. Выпуск, который запущен в контейнерах, в окно не попадал, поэтому для образов ботов (`myrmidon-hermes`, `-hermes-dev`, `-hermes-node`: тянутся по digest, без тегов) окно оставляло два устаревших поколения сверх работающего. На боевом хосте накопилось по четыре поколения каждого образа бота (2,9 + 1,6 + 1,2 ГБ на поколение); выкаты rc.41 и rc.42 писали «0 image(s) removed», диск упал до 8% свободного.
- Теперь окно соответствует настройке: текущий выпуск плюс `MYRMIDON_DEPLOY_IMAGE_KEEP` предыдущих, отдельно по каждому репозиторию. Самый новый занятый контейнером образ — текущий выпуск, он остаётся; образы новее него (только что подтянутые, ещё не запущенные) остаются всегда и в окно не считаются; после текущего выпуска остаётся не больше `keep` незанятых образов, всё более старое незанятое удаляется. Репозиторий без занятых образов, как и раньше, оставляет `keep + 1` самых новых. Образ, занятый любым контейнером, по-прежнему не удаляется никогда.
- Итоговая строка очистки теперь называет и число оставленных образов новее запущенного.
