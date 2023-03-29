
/**
 * @fileoverview Script to sumbmit task of counting
 * usable number of Landsat observations
 * 
 * @author Yingtong Zhang <zhangyt@bu.edu>
 * 
 * @license 
 * Copyright 2019 Boston University 
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * 
**/

var continents = ee.FeatureCollection("users/ytzhang/Continents"),
    TILES = ee.FeatureCollection("projects/GLANCE/ANCILLARY/TILES/GLOBAL_MAPPING_TILES_V1")

var uiUtils = require('users/ytzhang/glance_yz:ccdcUtilities/ui')
var outPath = 'nameOfYourProject/nameOfYourFolder/';

var continentList = [['Asia', 'AS'], ['North America', 'NA'], ['Europe', 'EU'], ['Africa', 'AF'], 
                    ['South America', 'SA'], ['Australia', 'AU'], ['Oceania','OC']];


var Years = [[2000,2000], [2001,2001], [2002,2002], [2003,2003], [2004,2004], [2005,2005], [2006,2006], 
  [2007,2007], [2008,2008], [2009,2009], [2010,2010], [2011,2011], [2012,2012], [2013,2013], [2014,2014], 
  [2015,2015], [2016,2016], [2017,2017], [2018,2018], [2019,2019], [2020,2020], [2021,2021], [2022,2022]];

var BandName = ['Y2000','Y2001','Y2002','Y2003','Y2004','Y2005','Y2006','Y2007','Y2008','Y2009','Y2010',
        'Y2011','Y2012','Y2013','Y2014','Y2015','Y2016','Y2017','Y2018','Y2019','Y2020','Y2021','Y2022'];

// define the starting and ending month
var sMonth = 1
var eMonth = 12

/**
* Get the annual number of observation maps
* notice: this function loops through continent geometries because it runs 
* relatively coarse resolution maps. If 30m scale map is more desired, switch
* to smaller grids and apply this function 
* @param {List} ct: continent's full name and abbreviation list
**/

var obsList = continentList.map(function(ct){

    var id = ct[0];
    var grid = ee.Feature(continents.filterMetadata('CONTINENT', 'equals', id).first());

    /**
    * Loop through year list to get annual maps
    * The year list can be changed to any desired time range
    * @param {String} year: client-side year list
    **/
    var obsByCt = Years.map(function(year){
        var sYear = year[0];
        var eYear = year[1];

        // yrStr is not used anymore, need to be removed
        // the last param is indicating if include Tier 2 images or not
        var nobs = ee.Image(uiUtils.getAnnualNumOfObs(sYear, eYear, sMonth, eMonth, grid.geometry(), true)).uint16()

        return nobs
    })

    // cast list of images to multi-band images
    var obsImg = ee.ImageCollection(obsByCt).toBands().rename(BandName)

    Export.image.toAsset({
        image: obsImg,
        description: 'NumOfObs_' + id + '_C2', 
        assetId: outPath + 'C2_' + ct[1] + '_NumOfObs_900m',
        // switch to 30 if needed
        scale: 900,
        maxPixels: 1e13,
        region: grid.geometry()
    });

})



