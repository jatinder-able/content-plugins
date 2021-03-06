org.ekstep.contenteditor.basePlugin.extend({
    editorState: undefined,
    telemetryService: org.ekstep.contenteditor.api.getService(ServiceConstants.TELEMETRY_SERVICE),
    lastSaved: undefined,
    popUpValues: {},
    isSaveNotificationPopupOpened: false,
    contentService: org.ekstep.contenteditor.api.getService(ServiceConstants.CONTENT_SERVICE),
    popupService: org.ekstep.contenteditor.api.getService(ServiceConstants.POPUP_SERVICE),
    conflictdialogOptions: {
        showPlatformPreview: false
    },
    initialize: function() {
        var instance = this;
        ecEditor.addEventListener('org.ekstep.editorstate:state', this.setEditorState, this);
        ecEditor.addEventListener('org.ekstep.contenteditor:save', this.resolveSaveFn, this);
        ecEditor.addEventListener('org.ekstep.contenteditor:save:meta', this.saveMetadata, this);
        ecEditor.addEventListener('org.ekstep.contenteditor:preview', function(event, data) {
            instance.previewContent(data.fromBeginning);
        }, this);
        ecEditor.addEventListener('org.ekstep.contenteditor:save:force', this.saveBrowserContent, this);
        ecEditor.addEventListener('org.ekstep.contenteditor:review', this.reviewContent, this);
        ecEditor.addEventListener("org.ekstep.contenteditor:publish", this.publishContent, this);
        ecEditor.addEventListener("org.ekstep.contenteditor:reject", this.rejectContent, this);
        ecEditor.addEventListener("org.ekstep.contenteditor:acceptFlag", this.acceptContentFlag, this);
        ecEditor.addEventListener("org.ekstep.contenteditor:discardFlag", this.discardContentFlag, this);
        ecEditor.addEventListener("org.ekstep.contenteditor:retire", this.retireContent, this);
        ecEditor.addEventListener("org.ekstep.contenteditor:unlistedPublish", this.unlistedPublishContent, this);
        ecEditor.addEventListener("org.ekstep.contenteditor:Unauthorized", this.unauthorizedToken, this);
    },
    unauthorizedToken: function(){
        this.popUpValues.headerMsg = 'Your session has timed out due to inactivity. Please login to resume!';
        this.popUpValues.popUpIcon = 'circle remove red';
        this.popUpValues.showCloseButton = true;
        this.popUpValues.unauthorized = 'unauthorized';
    },
    setEditorState: function(event, data) {
        if (data) this.editorState = data;
    },
    reviewContent: function(event, callback) {
        var contentId = ecEditor.getContext('contentId');
        ecEditor.getService(ServiceConstants.CONTENT_SERVICE).sendForReview({ contentId: contentId, channel: ecEditor.getContext('channel') }, function(err, res) {
            if (res && res.data && res.data.responseCode == "OK") {
                ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                    title: 'Content sent for review...',
                    position: 'topCenter',
                    icon: 'fa fa-check-circle'
                });
                callback && callback(err, res);
            } else {
                ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Sending for review failed, please try again later...',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
                callback && callback(err, res);
            }
        });
    },
    resolveSaveFn: function(event, data) {
        var meta = ecEditor.getService(ServiceConstants.CONTENT_SERVICE).getContentMeta(ecEditor.getContext('contentId'));
        switch (meta.mimeType) {
            case "application/vnd.ekstep.ecml-archive":
                this.saveContent(event, data);
                this.conflictdialogOptions.showPlatformPreview = true;
                break;
            case "application/vnd.ekstep.content-collection":
                this.saveCollectionContent(event, data);
                break;
            case "application/vnd.ekstep.html-archive":
            case "application/vnd.ekstep.h5p-archive":
            case "application/epub":
            case "video/mp4":
            case "application/pdf":
            case "video/x-youtube":
            case "video/webm":
            case "text/x-url":
                this.saveGenericEditorContent(event, data);
                break;
            default:
                data.callback && data.callback("unable to resolve save call for the mimetype");
                break;
        }
    },
    saveGenericEditorContent: function(event, data) {
        var options = ecEditor._.assign({ savingPopup: true, successPopup: true, failPopup: true }, data);
        if (options.savingPopup) this.saveNotification('saving');
        this._patchContent(data, data.body, options);
    },
    saveContent: function(event, options) {
        console.log('Save invoked:', event, options)
        options = ecEditor._.assign({ savingPopup: true, successPopup: true, failPopup: true, callback: function() {} }, options);
        if (options.savingPopup) this.saveNotification('saving');

        var contentMeta = {};
        if (options.contentMeta) {
            contentMeta = options.contentMeta;
        }
        org.ekstep.pluginframework.eventManager.dispatchEvent('content:before:save');
        // TODO: Show saving dialog
        var contentBody = org.ekstep.contenteditor.stageManager.toECML();
        if (typeof org.ekstep.contenteditor.stageManager.updateStageIcons === "function") { // safe to use the function
            contentMeta.stageIcons = JSON.stringify(org.ekstep.contenteditor.stageManager.updateStageIcons());
        } else {
            contentMeta.stageIcons = JSON.stringify(org.ekstep.contenteditor.stageManager.getStageIcons());
        }
        // Get and set assessment summary
        var summary = org.ekstep.contenteditor.stageManager.getSummary();
        if (summary){
            contentMeta.totalQuestions = summary.totalQuestions;
            contentMeta.totalScore = summary.totalScore;
            var metaData = ecEditor.getService(ServiceConstants.CONTENT_SERVICE).getContentMeta(ecEditor.getContext('contentId'))
            if( !ecEditor._.isEqual(ecEditor._.map(summary.questions, 'identifier').sort(), ecEditor._.map(metaData.questions, 'identifier').sort())){
                contentMeta.questions = summary.questions;
            }
        }
        contentMeta.assets = ecEditor._.compact(org.ekstep.contenteditor.stageManager.assets);
        contentMeta.editorState = JSON.stringify(this.editorState);
        contentMeta.pragma = org.ekstep.contenteditor.stageManager.getPragma();
        this._patchContent(contentMeta, contentBody, options);
    },
    _patchContent: function(contentMeta, contentBody, options) {
        var instance = this;
        // to remove angular's $$hashkey from meta object
        if (contentMeta) contentMeta = JSON.parse(angular.toJson(contentMeta));
        this.patchContent(contentMeta, contentBody, function(err, res) {
            if (err) {
                if (res && !ecEditor._.isUndefined(res.responseJSON)) {
                    // This could be converted to switch..case to handle different error codes
                    if (res.responseJSON.params.err == "ERR_STALE_VERSION_KEY")
                        instance.showConflictDialog(options);
                    else {
                        instance.changePopupValues('error');
                    }
                } else {
                    if (options && options.failPopup) {
                        if (!options.savingPopup) instance.saveNotification();
                        instance.changePopupValues('error');
                    }

                }
            } else if (res && res.data.responseCode == "OK") {
                var meta = ecEditor.getService(ServiceConstants.CONTENT_SERVICE).getContentMeta(ecEditor.getContext('contentId'));
                if(meta.mimeType === 'application/vnd.ekstep.content-collection' && org.ekstep.services.stateService.state.dialCodeMap){
                    var dialCode = _.get(org.ekstep.services.stateService.state.dialCodeMap, ecEditor.getContext('contentId'));
                    if(!_.isUndefined(dialCode)){
                        instance.dialcodeLink([{"dialcode" : dialCode, "identifier": ecEditor.getContext('contentId')}]);
                        instance.storeDialCodes(ecEditor.getContext('contentId'), dialCode);
                        _.unset(org.ekstep.services.stateService.state.dialCodeMap, ecEditor.getContext('contentId'))
                    }
                }
                if (options && options.successPopup) {
                    if (!options.savingPopup) instance.saveNotification();
                    instance.changePopupValues('success');
                }
                ecEditor.dispatchEvent("org.ekstep.contenteditor:after-save", {});
            }
            if (typeof options.callback === "function") options.callback(err, res);
        }, options);
    },
    saveBrowserContent: function(event, options) {
        var instance = this;
        // Fetch latest versionKey and then save the content from browser
        this.fetchPlatformContentVersionKey(function(platformContentVersionKey) {
            //Invoke save function here...
            instance.resolveSaveFn(event, options);
        });
    },
    patchContent: function(metadata, body, cb, options) {
        var instance = this;
        if (org.ekstep.contenteditor.migration && org.ekstep.contenteditor.migration.isMigratedContent()) {
            if (!metadata) metadata = {};
            metadata.oldContentBody = org.ekstep.contenteditor.migration.getBackupContent();
            var migrationPopupCb = function(err, res) {
                if (res) instance.contentService.saveContent(org.ekstep.contenteditor.api.getContext('contentId'), metadata, body, cb);
                if (err) options && options.callback('save action interrupted by user');
            }
            instance.showMigratedContentSaveDialog(migrationPopupCb);
        } else {
            instance.contentService.saveContent(org.ekstep.contenteditor.api.getContext('contentId'), metadata, body, cb);
        }
    },
    saveMetadata: function(event, options) {
        this._patchContent(options.contentMeta, undefined, options);
    },
    showMigratedContentSaveDialog: function(callback) {
        var instance = this;
        this.popupService.open({
            template: ecEditor.resolvePluginResource(instance.manifest.id, instance.manifest.ver, "editor/partials/migratedContentSaveMsg.html"),
            controller: ['$scope', function($scope) {
                $scope.saveContent = function() {
                    org.ekstep.contenteditor.migration.clearMigrationFlag();
                    callback(undefined, true);
                }

                $scope.enableSaveBtn = function() {
                    instance.saveBtnEnabled = true;
                    callback(true, undefined);
                }
            }],
            showClose: false,
            closeByDocument: false,
            closeByEscape: false
        });
    },
    saveNotification: function(message) {
        var template = "editor/partials/saveMessage.html";
        var instance = this;
        var config = {
            template: ecEditor.resolvePluginResource(instance.manifest.id, instance.manifest.ver, template),
            controller: ['$scope', function($scope) {
                $scope.popUpValues = instance.popUpValues;
                $scope.$on('ngDialog.opened', function(e, $dialog) {
                    instance.isSaveNotificationPopupOpened = true;
                });
                //Close the editor and redirect to login page when session out
                $scope.unauthorizedUser = function() {
                   if(this.popUpValues.unauthorized == 'unauthorized') 
                        ecEditor.dispatchEvent("org.ekstep:sunbirdcommonheader:close:editor");
                };
            }],
            showClose: false,
            closeByEscape: false,
            closeByDocument: false
        }
        console.log('config', config);
        this.changePopupValues(message);
        if (!instance.isSaveNotificationPopupOpened) {
            this.popupService.open(config, function() {
                instance.isSaveNotificationPopupOpened = false;
            });
        }
    },
    changePopupValues: function(message) {
        if (message === 'success') {
            this.popUpValues.headerMsg = 'Content Saved!';
            this.popUpValues.popUpIcon = 'circle check green';
            this.popUpValues.showCloseButton = true;
            this.popUpValues.saveNotificationCloseButton = 'saveSuccessNotificationCloseButton';
        } else if (message === 'error') {
            this.popUpValues.headerMsg = 'Failed to save Content';
            this.popUpValues.popUpIcon = 'circle remove red';
            this.popUpValues.showCloseButton = true;
            this.popUpValues.saveNotificationCloseButton = 'saveFailNotificationCloseButton';
        }
        if (message === 'saving') {
            this.popUpValues.headerMsg = 'Saving content please wait...';
            this.popUpValues.showCloseButton = false;
        }
    },
    showConflictDialog: function(options) {
        var instance = this;
        this.popupService.open({
            template: ecEditor.resolvePluginResource(instance.manifest.id, instance.manifest.ver, "editor/partials/conflictDialog.html"),
            controller: ['$scope', function($scope) {
                //Platform copy
                $scope.showPlatformPreview = false;
                if (instance.conflictdialogOptions.showPlatformPreview) $scope.showPlatformPreview = true;

                $scope.previewPlatformContent = function() {
                    instance.previewPlatformContent();
                };
                $scope.saveBrowserContent = function() {
                    instance.saveBrowserContent(undefined, options);
                    $scope.closeThisDialog();
                };
                //Existing copy
                $scope.previewContent = function() {
                    instance.previewContent();
                };
                $scope.refreshContent = function() {
                    instance.refreshContent();
                };
                $scope.firetelemetry = function(menu, menuType) {
                    instance.telemetryService.interact({ "id": "button", "type": "click", "subtype": "popup", "target": menuType, "pluginid": 'org.ekstep.contenteditorfunctions', 'pluginver': '1.2', "objectid": menu.id, "stage": ecEditor.getCurrentStage().id });
                };
                $scope.showAdvancedOption = false;
            }],
            className: 'ngdialog-theme-plain header-conflict-dialog',
            showClose: false,
            closeByDocument: true,
            closeByEscape: true
        });
    },
    previewContent: function(fromBeginning) {
        var currentStage = _.isUndefined(fromBeginning) ? true : false;
        org.ekstep.pluginframework.eventManager.dispatchEvent("atpreview:show", { contentBody: org.ekstep.contenteditor.stageManager.toECML(), 'currentStage': currentStage });
    },
    refreshContent: function() {
        // Refresh the browser as user want to fetch the version from platform
        location.reload();
    },
    previewPlatformContent: function() {
        // Fetch latest content body from Platform and then show preview
        this.fetchPlatformContentBody(function(platformContentBody) {
            org.ekstep.pluginframework.eventManager.dispatchEvent("atpreview:show", { contentBody: platformContentBody, 'currentStage': true });
        });
    },
    fetchPlatformContentVersionKey: function(cb) {
        // Get the latest VersionKey and then save content
        org.ekstep.contenteditor.api.getService(ServiceConstants.CONTENT_SERVICE).getContentVersionKey(org.ekstep.contenteditor.api.getContext('contentId'), function(err, content) {
            if (err) {
                alert("Failed to get updated version key. Please report an issue.");
            }
            // if versionKey is available, pass success and save
            if (content.versionKey) {
                cb(content);
            }
        });
    },
    fetchPlatformContentBody: function(cb) {
        // Get the latest VersionKey and then save content
        org.ekstep.contenteditor.api.getService(ServiceConstants.CONTENT_SERVICE).getContent(org.ekstep.contenteditor.api.getContext('contentId'), function(err, content) {
            if (err) {
                alert("Failed to get updated content. Please report an issue.");
            }
            if (content && content.body) {
                try {
                    var contentBody = JSON.parse(content.body);
                    cb(contentBody);
                } catch (e) {
                    alert("Failed to parse body from platform. Please report an issue.");
                    //contentBody = $scope.convertToJSON(content.body);
                }
            }
        });
    },
    publishContent: function(event, data) {
        var contentId = ecEditor.getContext('contentId');
        ecEditor.getService(ServiceConstants.CONTENT_SERVICE).publishContent({ contentId: contentId, channel: ecEditor.getContext('channel'), data:data }, function(err, res) {
            if (res && res.data && res.data.responseCode == "OK") {
                ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                    title: 'Content published successfully!',
                    position: 'topCenter',
                    icon: 'fa fa-check-circle'
                });
            } else {
                ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Unable to publish content, try again!',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
            }
            data.callback && data.callback(err, res);
        });
    },
    rejectContent: function(event, data) {
        ecEditor.getService(ServiceConstants.CONTENT_SERVICE).rejectContent({ contentId: ecEditor.getContext('contentId'), channel: ecEditor.getContext('channel'), data:data }, function(err, res) {
            if (res && res.data && res.data.responseCode == "OK") {
                ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                    title: 'Content rejected successfully!',
                    position: 'topCenter',
                    icon: 'fa fa-check-circle'
                });
            } else {
                ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Unable to reject content, try again!',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
            }
            data.callback && data.callback(err, res);
        });
    },
    acceptContentFlag: function(event, data) {
        ecEditor.getService(ServiceConstants.CONTENT_SERVICE).acceptContentFlag({ contentId: ecEditor.getContext('contentId') }, function(err, res) {
            if (res && res.data && res.data.responseCode == "OK") {
                ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                    title: 'Content flag accepted successfully!',
                    position: 'topCenter',
                    icon: 'fa fa-check-circle'
                });
            } else {
                ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Unable to accept content flag, try again!',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
            }
            data.callback && data.callback(err, res);
        });
    },
    discardContentFlag: function(event, data) {
        ecEditor.getService(ServiceConstants.CONTENT_SERVICE).discardContentFlag({ contentId: ecEditor.getContext('contentId') }, function(err, res) {
            if (res && res.data && res.data.responseCode == "OK") {
                ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                    title: 'Content flag discarded successfully!',
                    position: 'topCenter',
                    icon: 'fa fa-check-circle'
                });
            } else {
                ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Unable to discard content flag, try again!',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
            }
            data.callback && data.callback(err, res);
        });
    },
    retireContent: function(event, data) {
        ecEditor.getService(ServiceConstants.CONTENT_SERVICE).retireContent({ contentId: ecEditor.getContext('contentId') }, function(err, res) {
            if (res && res.data && res.data.responseCode == "OK") {
                ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                    title: 'Content retired successfully!',
                    position: 'topCenter',
                    icon: 'fa fa-check-circle'
                });
            } else {
                ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Unable to retire content, try again!',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
            }
            data.callback && data.callback(err, res);
        });
    },
    saveCollectionContent: function(event, data) {
        data = data || {};
        var instance = this;
        var nodes = { validNodes: [], invalidNodes: [] }
        var contentMetaData = ecEditor.getService(ServiceConstants.CONTENT_SERVICE).getContentMeta(ecEditor.getContext('contentId'));
        
        if (contentMetaData && contentMetaData.versionKey){
            if(org.ekstep.collectioneditor.cache.nodesModified[contentMetaData.identifier] && org.ekstep.collectioneditor.cache.nodesModified[contentMetaData.identifier].metadata){
                org.ekstep.collectioneditor.cache.nodesModified[contentMetaData.identifier].metadata.versionKey = contentMetaData.versionKey;
            }
        }

        var contentBody = org.ekstep.collectioneditor.api.getService('collection').getCollectionHierarchy();
        
        if (contentBody) {
            //angular.toJson to remove $$hashKey from scope object
            contentBody = JSON.parse(angular.toJson(contentBody));
        }
        console.log('contentBody', contentBody);

        var isValidSave = function() {
            var mandatoryFields = ["name", "contentType", "mimeType"];
            ecEditor._.forIn(org.ekstep.collectioneditor.cache.nodesModified, function(data, id) {
                mandatoryFields.forEach(function(key) {
                    if (!data.metadata.hasOwnProperty(key)) {
                        nodes.invalidNodes.push(id);
                    } else {
                        if (data.metadata[key]) {
                            nodes.validNodes.push(id);
                        } else {
                            nodes.invalidNodes.push(id)
                        }
                    }
                });
            });
        }

        var isvalid = isValidSave();
        this.lowlightNode(nodes.validNodes);
        if (_.size(nodes.invalidNodes) > 0) {
            if (data.showNotification) ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                message: 'Please update the collection details before save',
                position: 'topCenter',
                icon: 'fa fa-warning'
            });
            this.hightlightNode(nodes.invalidNodes);
            data.callback && data.callback("mandatory fields are missing in the data!");
            return false;
        }
        ecEditor.getService(ServiceConstants.CONTENT_SERVICE).saveCollectionHierarchy({ body: contentBody }, function(err, res) {
            if (res && res.data && res.data.responseCode == "OK") {
                if (data.showNotification) ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                    title: 'Content saved successfully!',
                    position: 'topCenter',
                    icon: 'fa fa-check-circle'
                });
                instance.highlightNodeForInvalidDialCode(res, contentBody.nodesModified);
                org.ekstep.collectioneditor.api.getService('collection').clearCache();
                // update node id's of collection
                ecEditor._.forIn(res.data.result.identifiers, function(newId, oldId) {
                    var node = ecEditor.getService(ServiceConstants.COLLECTION_SERVICE).getNodeById(oldId);
                    if (node) node.data.id = newId;
                });
                ecEditor.dispatchEvent("meta:after:save", {});

            } else if(err && res.status === 401 && res.statusText === "Unauthorized") {
                if (data.showNotification) ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Your session has timed out due to inactivity. Please login to resume!',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
            } else {
                if (data.showNotification) ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Unable to save the content, try again!',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
            }
            data.callback && data.callback(err, res);
        });
    },
    highlightNodeForInvalidDialCode: function(res, nodesModified) {
        var instance = this;
        var mapArr = [];
        ecEditor._.forEach(org.ekstep.services.stateService.state.invaliddialCodeMap, function(value, key) {
            if (_.has(res.data.result.identifiers, key)) {
                delete org.ekstep.services.stateService.state.invaliddialCodeMap[key];
                org.ekstep.services.stateService.setState('invaliddialCodeMap', res.data.result.identifiers[key], value);
                org.ekstep.services.collectionService.highlightNode(res.data.result.identifiers[key]);
                instance.storeDialCodes(res.data.result.identifiers[key], value);
            }else{
                instance.storeDialCodes(key, value);
                org.ekstep.services.collectionService.highlightNode(key);
           }
        });
        ecEditor._.forEach(org.ekstep.services.stateService.state.dialCodeMap, function(value, key) {
            if (_.has(res.data.result.identifiers, key)) {
                delete org.ekstep.services.stateService.state.dialCodeMap[key];
                org.ekstep.services.stateService.setState('dialCodeMap', res.data.result.identifiers[key], value);
                mapArr.push({ "identifier": res.data.result.identifiers[key], "dialcode": value });
                org.ekstep.services.collectionService.lowLightNode(res.data.result.identifiers[key]);
                instance.storeDialCodes(res.data.result.identifiers[key], value);
            } else {
                mapArr.push({ "identifier": key, "dialcode": value });
                org.ekstep.services.collectionService.lowLightNode(key);
                instance.storeDialCodes(key, value);
            }
        });
        var dialcodesUpdated = false;
        ecEditor._.forIn(nodesModified, function(node) {
            if(!_.isUndefined(node.metadata.dialcodes) && !dialcodesUpdated){
                dialcodesUpdated = true;
            }else{
                var dialObj =  _.find(mapArr,function(Obj){
                    return Obj.identifier === res.data.result.content_id
                })
                if(!_.isUndefined(dialObj)){
                    dialcodesUpdated = true;
                }
            }
        });
        if(dialcodesUpdated){
            instance.dialcodeLink(mapArr);
        }
    },
    dialcodeLink: function(dialcodeMap) {
        var dialcodeMapObj = _.find(dialcodeMap, function(o){
		    return o.dialcode != undefined
        });
        if(!_.isEmpty(dialcodeMap)){
            var request = {
                "request": {
                    "content": dialcodeMap
                }
            };
            ecEditor.getService('dialcode').dialcodeLink(ecEditor.getContext('contentId'), ecEditor.getContext('channel'), request, function(err, rep) {
                if (!err) {
                    if( !ecEditor._.isEmpty(org.ekstep.services.stateService.state.dialCodeMap) && !ecEditor._.isEmpty(org.ekstep.services.stateService.state.invaliddialCodeMap)){
                        ecEditor.dispatchEvent("org.ekstep.toaster:warning", {
                            title: 'Unable to update some of the QR codes.',
                            position: 'topCenter',
                            icon: 'fa fa-warning'
                        });
                    } else {
                        ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                            title: 'QR code(s) updated successfully!',
                            position: 'topCenter',
                            icon: 'fa fa-check-circle'
                        });
                    }
                }else{
                    if (!ecEditor._.isUndefined(err.responseJSON) && err.responseJSON.params && err.responseJSON.params.err == "ERR_DIALCODE_LINK"){
                        ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                            title: err.responseJSON.params.errmsg,
                            position: 'topCenter',
                            icon: 'fa fa-warning'
                        });
                    }else{
                        ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                            title: 'QR code(s) updating failed!',
                            position: 'topCenter',
                            icon: 'fa fa-warning'
                        });
                    }
                }
            });
        }else if(!ecEditor._.isEmpty(org.ekstep.services.stateService.state.invaliddialCodeMap)){
            ecEditor.dispatchEvent("org.ekstep.toaster:warning", {
                title: 'Unable to update some of the QR codes.',
                position: 'topCenter',
                icon: 'fa fa-warning'
            });
        }
    },
    storeDialCodes: function(nodeId, dialCode){
        var node = ecEditor.getService(ServiceConstants.COLLECTION_SERVICE).getNodeById(nodeId);
        if(node && node.data)
            node.data.metadata["dialcodes"] = dialCode;
    },
    hightlightNode: function(invalidNodes) {
        _.forEach(_.omitBy(_.uniq(invalidNodes), _.isEmpty), function(key) {
            org.ekstep.services.collectionService.highlightNode(key)
        });
    },
    lowlightNode: function(validNodes) {
        _.forEach(_.omitBy(_.uniq(validNodes), _.isEmpty), function(key) {
            org.ekstep.services.collectionService.lowLightNode(key)
        });
    },
    unlistedPublishContent: function(event, data) {
        var contentId = ecEditor.getContext('contentId');
        ecEditor.getService(ServiceConstants.CONTENT_SERVICE).unlistedPublishContent({ contentId: contentId }, function(err, res) {
            if (res && res.data && res.data.responseCode == "OK") {
                ecEditor.dispatchEvent("org.ekstep.toaster:success", {
                    title: 'Content limited shared successfully!',
                    position: 'topCenter',
                    icon: 'fa fa-check-circle'
                });
            } else {
                ecEditor.dispatchEvent("org.ekstep.toaster:error", {
                    message: 'Unable to share content, try again!',
                    position: 'topCenter',
                    icon: 'fa fa-warning'
                });
            }
            data.callback && data.callback(err, res);
        });
    }
});

//# sourceURL=contenteditorfunctions.js
